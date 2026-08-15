<?php
// Дашборд — ETL: amoCRM и AlfaCRM → SQLite.
//
// Запуск из cron хостинга (cPanel → Cron Jobs), два расписания:
//   каждые 15 минут:  php /path/to/api/etl.php job=delta
//   раз в сутки ночью: php /path/to/api/etl.php job=nightly
// или по HTTP (если cron умеет только curl):
//   curl "https://.../api/etl.php?job=delta&cron_key=<из config.php>"
//
// nightly = полный пересбор (как pplRebuildPays + runAmoEtl + клиенты).
// delta   = только изменившееся: сделки amo за сутки, платежи Альфы за два дня.
// Благодаря дельте раз в 15 минут страница всегда показывает почти живые
// данные — отдельный механизм «живой дельты в запросе» здесь не нужен.
declare(strict_types=1);

require __DIR__ . '/lib.php';
require __DIR__ . '/db.php';
require __DIR__ . '/core.php';

// --- доступ: CLI свободно, HTTP только с cron_key ---
if (PHP_SAPI !== 'cli') {
    if (($_GET['cron_key'] ?? '') !== (string)(cfg()['cron_key'] ?? '')
        || (string)(cfg()['cron_key'] ?? '') === '') {
        json_out(['error' => 'unauthorized'], 401);
    }
}
@set_time_limit(1800);

// --- разбор job= из CLI-аргументов или GET ---
$job = $_GET['job'] ?? '';
foreach ($argv ?? [] as $a) {
    if (strpos($a, 'job=') === 0) $job = substr($a, 4);
}

$log = [];
$t0 = microtime(true);
try {
    switch ($job) {
        case 'nightly':
            $log['leads']     = etl_leads(true);
            $log['customers'] = etl_customers();
            $log['pays']      = etl_pays(true);
            break;
        case 'delta':
            $log['leads'] = etl_leads(false);
            $log['pays']  = etl_pays(false);
            break;
        case 'leads':     $log['leads'] = etl_leads(true); break;
        case 'customers': $log['customers'] = etl_customers(); break;
        case 'pays':      $log['pays'] = etl_pays(true); break;
        default:
            $out = ['error' => 'job=nightly | delta | leads | customers | pays'];
            if (PHP_SAPI === 'cli') { fwrite(STDERR, $out['error'] . "\n"); exit(1); }
            json_out($out, 400);
    }
    kv_set('etl_' . $job . '_at', date('c'));
    $log['seconds'] = round(microtime(true) - $t0, 1);
    if (PHP_SAPI === 'cli') { echo json_encode($log, JSON_UNESCAPED_UNICODE) . "\n"; exit(0); }
    json_out(['ok' => true] + $log);
} catch (Throwable $e) {
    $msg = 'ETL ' . $job . ': ' . $e->getMessage();
    if (PHP_SAPI === 'cli') { fwrite(STDERR, $msg . "\n"); exit(1); }
    json_out(['error' => $msg], 500);
}

/* ==================== amoCRM → leads ==================== */

/** Справочник воронок и статусов: id → имя. */
function amo_pipelines(): array {
    $data = amo_get('/leads/pipelines');
    $map = [];
    foreach ($data['_embedded']['pipelines'] ?? [] as $pl) {
        $st = [];
        foreach ($pl['_embedded']['statuses'] ?? [] as $s) $st[$s['id']] = $s['name'];
        $map[$pl['id']] = ['name' => $pl['name'], 'statuses' => $st];
    }
    return $map;
}

function amo_field($lead, int $fieldId): string {
    foreach ($lead['custom_fields_values'] ?? [] as $f) {
        if (($f['field_id'] ?? 0) === $fieldId && !empty($f['values'][0])) {
            return (string)($f['values'][0]['value'] ?? '');
        }
    }
    return '';
}

/**
 * Сделки amo → таблица leads. $full — вся история; иначе только
 * изменённые за последние сутки (менеджеры дозаполняют источник и телефон).
 */
function etl_leads(bool $full): array {
    $a = cfg()['amo'];
    $pipelines = amo_pipelines();
    $filter = $full ? '' : '&filter[updated_at][from]=' . (time() - 86400);

    $leads = [];
    for ($page = 1; $page <= ($full ? 200 : 8); $page++) {
        $data = amo_get('/leads?with=contacts&limit=250&page=' . $page . $filter);
        $chunk = $data['_embedded']['leads'] ?? [];
        foreach ($chunk as $l) $leads[] = $l;
        if (count($chunk) < 250) break;
    }

    // контакты чанками: телефон + ссылка на Альфу (как fetchContacts_ в etl_amo.gs)
    $contactIds = [];
    foreach ($leads as $l) {
        $cs = $l['_embedded']['contacts'] ?? [];
        if ($cs) $contactIds[$cs[0]['id']] = true;
    }
    $byContact = [];
    $ids = array_keys($contactIds);
    for ($i = 0; $i < count($ids); $i += 50) {
        $chunk = array_slice($ids, $i, 50);
        $q = implode('&', array_map(fn($id) => 'filter[id][]=' . $id, $chunk));
        $data = amo_get('/contacts?' . $q . '&limit=50');
        foreach ($data['_embedded']['contacts'] ?? [] as $c) {
            $byContact[$c['id']] = [
                'phone' => norm_phone(amo_field($c, (int)$a['field_phone'])),
                'alfa'  => amo_field($c, (int)$a['field_alfa_url']),
            ];
        }
    }

    $rows = [];
    foreach ($leads as $l) {
        $cs  = $l['_embedded']['contacts'] ?? [];
        $cid = $cs ? (string)$cs[0]['id'] : '';
        $cd  = $byContact[$cid] ?? ['phone' => '', 'alfa' => ''];
        $pl  = $pipelines[$l['pipeline_id'] ?? 0] ?? ['name' => '', 'statuses' => []];
        $statusId = (int)($l['status_id'] ?? 0);
        $rows[] = [
            'lead_id'      => (int)$l['id'],
            'created_at'   => gmdate('c', (int)$l['created_at']),
            'updated_at'   => (int)($l['updated_at'] ?? 0),
            'phone_e164'   => $cd['phone'],
            'source'       => amo_field($l, (int)$a['field_source']),
            'utm_source'   => amo_field($l, (int)$a['field_utm_source']),
            'utm_campaign' => amo_field($l, (int)$a['field_utm_campaign']),
            'utm_content'  => amo_field($l, (int)$a['field_utm_content']),
            'fbclid'       => amo_field($l, (int)$a['field_fbclid']),
            'pipeline'     => $pl['name'],
            'stage'        => $pl['statuses'][$statusId] ?? (string)$statusId,
            'alfa_url'     => $cd['alfa'],
            'contact_id'   => $cid,
            'status'       => $statusId === 142 ? 'won' : ($statusId === 143 ? 'lost' : 'open'),
            'price'        => (float)($l['price'] ?? 0),
        ];
    }
    $n = db_upsert('leads',
        ['lead_id', 'created_at', 'updated_at', 'phone_e164', 'source', 'utm_source', 'utm_campaign',
         'utm_content', 'fbclid', 'pipeline', 'stage', 'alfa_url', 'contact_id', 'status', 'price'],
        $rows);
    return ['mode' => $full ? 'full' : 'delta', 'rows' => $n];
}

/* ==================== AlfaCRM → customers ==================== */

function etl_customers(): array {
    $rows = []; $seen = [];
    foreach (cfg()['alfa']['branches'] as $branch) {
        for ($page = 0; $page < 200; $page++) {
            // is_study 2 — и ученики, и лиды: записанные на пробное часто ещё лиды
            $data = alfa_page((int)$branch, 'customer', ['page' => $page, 'is_study' => 2]);
            $items = $data['items'] ?? [];
            foreach ($items as $c) {
                $id = (int)$c['id'];
                if (isset($seen[$id])) continue;
                $seen[$id] = true;
                $phones = [];
                foreach ((array)($c['phone'] ?? []) as $ph) {
                    $p = norm_phone((string)$ph);
                    if ($p !== '' && !in_array($p, $phones, true)) $phones[] = $p;
                }
                $amoContact = '';
                foreach ((array)($c['web'] ?? []) as $u) {
                    if (preg_match('~amocrm\.ru/contacts/detail/(\d+)~', (string)$u, $m)) { $amoContact = $m[1]; break; }
                }
                $rows[] = [
                    'customer_id'    => $id,
                    'branches'       => implode(';', (array)($c['branch_ids'] ?? [$branch])),
                    'phones'         => implode(';', $phones),
                    'amo_contact_id' => $amoContact,
                    'created_at'     => (string)($c['created_at'] ?? ''),
                    'name'           => (string)($c['name'] ?? ''),
                ];
            }
            if (count($items) < 50) break;
        }
    }
    $n = db_upsert('customers',
        ['customer_id', 'branches', 'phones', 'amo_contact_id', 'created_at', 'name'], $rows);
    return ['rows' => $n];
}

/* ==================== AlfaCRM → pays ==================== */

/**
 * Платежи. $full — вся история заново (дешёво и самовосстанавливается,
 * см. историю с loadAlphaMonth в HANDOFF); иначе — только за два дня
 * (фильтр date_from у Альфы рабочий, в отличие от document_date_from).
 */
function etl_pays(bool $full): array {
    $rows = []; $seen = [];
    $dateFrom = $full ? null : date('d.m.Y', time() - 2 * 86400);
    foreach (cfg()['alfa']['branches'] as $branch) {
        for ($page = 0; $page < 800; $page++) {
            $body = ['page' => $page, 'pay_type_id' => 1];
            if ($dateFrom !== null) $body['date_from'] = $dateFrom;
            $data = alfa_page((int)$branch, 'pay', $body);
            $items = $data['items'] ?? [];
            foreach ($items as $it) {
                if ((int)($it['pay_type_id'] ?? 0) !== 1) continue;   // страховка: только доход
                $id = (int)($it['id'] ?? 0);
                if (!$id || isset($seen[$id])) continue;
                $seen[$id] = true;
                $rows[] = [
                    'pay_id'        => $id,
                    'document_date' => any_iso((string)($it['document_date'] ?? '')),
                    'customer_id'   => (int)($it['customer_id'] ?? 0),
                    'income'        => (float)($it['income'] ?? 0),
                    'branch'        => (int)$branch,
                    'pay_item_id'   => (string)($it['pay_item_id'] ?? ''),
                    'payer_name'    => (string)($it['payer_name'] ?? ''),
                ];
            }
            if (count($items) < 50) break;
        }
    }
    // Полный пересбор: если Альфа отдала подозрительно мало — таблицу не
    // трогаем (тот же предохранитель, что в pplRebuildPays).
    if ($full && count($rows) < 1000) {
        throw new RuntimeException('Альфа отдала всего ' . count($rows) . ' платежей — таблицу не перезаписываем');
    }
    if ($full) db()->exec('DELETE FROM pays');
    $n = db_upsert('pays',
        ['pay_id', 'document_date', 'customer_id', 'income', 'branch', 'pay_item_id', 'payer_name'], $rows);
    return ['mode' => $full ? 'full' : 'delta', 'rows' => $n];
}
