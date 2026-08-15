<?php
// Дашборд — расчётное ядро. Построчный порт pplAlfaRevenueCore_ и
// pplChannelSummary_ из apps-script/people.gs: правила те же —
// платежи с даты заявки, период по дате заявки, клиент один раз,
// мост «ссылка → контакт → телефон». Менять логику здесь можно только
// синхронно с people.gs, пока живы оба бэкенда.
declare(strict_types=1);

/** Нормализация телефона к +375XXXXXXXXX (= normalizePhone_ из etl_amo.gs). */
function norm_phone(?string $raw): string {
    if ($raw === null || $raw === '') return '';
    $d = preg_replace('~\D~', '', $raw);
    if ($d === '') return '';
    if (strlen($d) === 11 && substr($d, 0, 2) === '80') $d = '375' . substr($d, 2);
    elseif (strlen($d) === 9) $d = '375' . $d;
    if (strlen($d) < 11) return '';
    return '+' . $d;
}

/** Дата из любого вида (ISO / «ДД.ММ.ГГГГ») → ГГГГ-ММ-ДД (= pplAnyIso_). */
function any_iso($v): string {
    $s = (string)$v;
    if (preg_match('~(\d{4})-(\d{2})-(\d{2})~', $s, $m)) return $m[1] . '-' . $m[2] . '-' . $m[3];
    if (preg_match('~(\d{2})\.(\d{2})\.(\d{4})~', $s, $m)) return $m[3] . '-' . $m[2] . '-' . $m[1];
    return '';
}

/** id клиента Альфы из ссылки (= pplAlfaCustomerId_): последняя группа цифр. */
function alfa_customer_id(?string $url): string {
    if (!$url) return '';
    if (!preg_match_all('~\d+~', $url, $m) || !$m[0]) return '';
    return end($m[0]);
}

/** Группа направления по имени воронки (= pplBrand_, карта из config). */
function brand_of(?string $pipeline): ?string {
    $key = mb_strtolower(trim((string)$pipeline));
    return cfg()['brand_map'][$key] ?? null;
}

/**
 * Ядро выручки (= pplAlfaRevenueCore_).
 * $leads     — строки leads (created_at, phone_e164, source, pipeline, alfa_url, lead_id, contact_id)
 * $customers — строки customers (customer_id, phones, amo_contact_id, name)
 * $pays      — строки pays (document_date, customer_id, income, pay_id)
 */
function alfa_revenue_core(array $leads, array $customers, array $pays, string $since, string $until): array {
    $byPhone = []; $byContact = []; $namesById = [];
    foreach ($customers as $c) {
        $cid = (string)$c['customer_id'];
        $namesById[$cid] = (string)($c['name'] ?? '');
        foreach (explode(';', (string)($c['phones'] ?? '')) as $ph) {
            if ($ph !== '') $byPhone[$ph][] = $cid;
        }
        $ac = trim((string)($c['amo_contact_id'] ?? ''));
        if ($ac !== '') $byContact[$ac][] = $cid;
    }

    // клиент → платежи; дедуп по pay_id (зеркальные филиалы Альфы)
    $paysBy = []; $seenPay = [];
    foreach ($pays as $r) {
        $id = trim((string)($r['customer_id'] ?? ''));
        if ($id === '') continue;
        $payId = (string)($r['pay_id'] ?? '');
        if ($payId !== '') {
            if (isset($seenPay[$payId])) continue;
            $seenPay[$payId] = true;
        }
        $paysBy[$id][] = ['date' => any_iso($r['document_date'] ?? ''), 'income' => (float)($r['income'] ?? 0)];
    }

    $inPeriod = [];
    foreach ($leads as $l) {
        $d = any_iso($l['created_at'] ?? '');
        if ($d >= $since && $d <= $until) { $l['_date'] = $d; $inPeriod[] = $l; }
    }
    $igLeads = array_values(array_filter($inPeriod,
        fn($l) => (bool)preg_match('~instagram~i', (string)($l['source'] ?? ''))));

    $customersOf = function (array $l) use ($byPhone, $byContact): array {
        $linked = alfa_customer_id($l['alfa_url'] ?? null);
        if ($linked !== '') return [$linked];
        $contact = trim((string)($l['contact_id'] ?? ''));
        if ($contact !== '' && isset($byContact[$contact])) return $byContact[$contact];
        $phone = norm_phone($l['phone_e164'] ?? null);
        return ($phone !== '' && isset($byPhone[$phone])) ? $byPhone[$phone] : [];
    };
    $paysSince = function (string $cid, string $date) use ($paysBy): float {
        $sum = 0.0;
        foreach ($paysBy[$cid] ?? [] as $p) {
            if ($p['date'] !== '' && $p['date'] >= $date) $sum += $p['income'];
        }
        return $sum;
    };

    $byBrand = []; $withPhone = 0; $withAlfa = 0; $paidCustomers = 0; $revenue = 0.0;
    $seenCustomers = []; $paidList = [];

    foreach ($igLeads as $l) {
        $key = brand_of($l['pipeline'] ?? null) ?? '(вне карты направлений)';
        if (!isset($byBrand[$key])) $byBrand[$key] = ['brand' => $key, 'leads' => 0, 'with_alfa' => 0, 'paid' => 0, 'revenue' => 0.0];
        $byBrand[$key]['leads']++;

        if (norm_phone($l['phone_e164'] ?? null) !== '') $withPhone++;

        $ids = $customersOf($l);
        if (!$ids) continue;
        $withAlfa++;
        $byBrand[$key]['with_alfa']++;

        $sum = 0.0; $hasNew = false;
        foreach ($ids as $cid) {
            if (isset($seenCustomers[$cid])) continue;
            $seenCustomers[$cid] = true;
            $hasNew = true;
            $cSum = $paysSince($cid, $l['_date']);
            $sum += $cSum;
            if ($cSum > 0) {
                $paidList[] = [
                    'customer_id' => $cid,
                    'name' => ($namesById[$cid] ?? '') !== '' ? $namesById[$cid] : ('клиент #' . $cid),
                    'brand' => $key,
                    'lead_date' => $l['_date'],
                    'revenue' => $cSum,
                ];
            }
        }
        if ($hasNew && $sum > 0) {
            $paidCustomers++;
            $revenue += $sum;
            $byBrand[$key]['paid']++;
            $byBrand[$key]['revenue'] += $sum;
        }
    }

    // разрез: клиент дедуплицируется ВНУТРИ строки (= slice() в people.gs)
    $slice = function (array $rows, callable $keyOf) use ($customersOf, $paysSince): array {
        $acc = []; $seen = [];
        foreach ($rows as $l) {
            $key = $keyOf($l);
            if (!isset($acc[$key])) $acc[$key] = ['key' => $key, 'leads' => 0, 'with_alfa' => 0, 'paid' => 0, 'revenue' => 0.0];
            $acc[$key]['leads']++;
            $ids = $customersOf($l);
            if (!$ids) continue;
            $acc[$key]['with_alfa']++;
            $sum = 0.0; $hasNew = false;
            foreach ($ids as $cid) {
                if (isset($seen[$key . '|' . $cid])) continue;
                $seen[$key . '|' . $cid] = true;
                $hasNew = true;
                $sum += $paysSince($cid, $l['_date']);
            }
            if ($hasNew && $sum > 0) { $acc[$key]['paid']++; $acc[$key]['revenue'] += $sum; }
        }
        usort($acc, fn($a, $b) => $b['leads'] <=> $a['leads']);
        return array_values($acc);
    };

    $bySource = array_map(
        fn($s) => ['source' => $s['key'], 'leads' => $s['leads'], 'with_alfa' => $s['with_alfa'], 'paid' => $s['paid'], 'revenue' => $s['revenue']],
        $slice($inPeriod, fn($l) => trim((string)($l['source'] ?? '')) !== '' ? trim((string)$l['source']) : '(не указан)')
    );
    $byPipeline = array_map(
        fn($s) => ['pipeline' => $s['key'], 'leads' => $s['leads'], 'with_alfa' => $s['with_alfa'], 'paid' => $s['paid'], 'revenue' => $s['revenue']],
        $slice($igLeads, fn($l) => trim((string)($l['pipeline'] ?? '')) !== '' ? trim((string)$l['pipeline']) : '(без воронки)')
    );

    $brands = array_values($byBrand);
    usort($brands, fn($a, $b) => ($b['revenue'] <=> $a['revenue']) ?: ($b['leads'] <=> $a['leads']));
    usort($paidList, fn($a, $b) => $b['revenue'] <=> $a['revenue']);

    return [
        'leads' => count($igLeads),
        'with_phone' => $withPhone,
        'with_alfa' => $withAlfa,
        'matched_share' => count($igLeads) ? $withAlfa / count($igLeads) : 0,
        'paid_customers' => $paidCustomers,
        'revenue' => $revenue,
        'brands' => $brands,
        'by_source' => $bySource,
        'by_pipeline' => $byPipeline,
        'paid_list' => $paidList,
    ];
}

/**
 * Сводка канала (= pplChannelSummary_): статусы amo по источникам и
 * воронкам + сопоставимость валют. $leads — строки leads периода с полями
 * status ('won'|'lost'|'open') и price. В PHP-версии статус и цена приходят
 * из БД (см. etl.php), а не из живого amo — БД обновляется кроном.
 */
function channel_summary(array $leads, array $spendByPlatform, string $amoCurrency): array {
    $bySource = [];
    foreach ($leads as $l) {
        $src = trim((string)($l['source'] ?? '')) !== '' ? trim((string)$l['source']) : '(не указан)';
        if (!isset($bySource[$src])) $bySource[$src] = ['source' => $src, 'leads' => 0, 'won' => 0, 'lost' => 0, 'open' => 0, 'revenue' => 0.0, 'won_without_price' => 0];
        $s = &$bySource[$src];
        $s['leads']++;
        $status = $l['status'] ?? 'open';
        if ($status === 'won') {
            $s['won']++;
            $s['revenue'] += (float)($l['price'] ?? 0);
            if (!(float)($l['price'] ?? 0)) $s['won_without_price']++;
        } elseif ($status === 'lost') $s['lost']++;
        else $s['open']++;
        unset($s);
    }
    $sources = array_values($bySource);
    usort($sources, fn($a, $b) => $b['leads'] <=> $a['leads']);

    $ig = ['leads' => 0, 'won' => 0, 'lost' => 0, 'open' => 0, 'revenue' => 0.0, 'won_without_price' => 0];
    foreach ($bySource as $k => $s) {
        if (preg_match('~instagram~i', $k)) { $ig = $s; break; }
    }

    $byPipeline = [];
    foreach ($leads as $l) {
        if (!preg_match('~instagram~i', (string)($l['source'] ?? ''))) continue;
        $p = trim((string)($l['pipeline'] ?? '')) !== '' ? trim((string)$l['pipeline']) : '(без воронки)';
        if (!isset($byPipeline[$p])) $byPipeline[$p] = ['pipeline_id' => 0, 'pipeline' => $p, 'leads' => 0, 'won' => 0, 'lost' => 0, 'open' => 0, 'revenue' => 0.0, 'won_without_price' => 0];
        $row = &$byPipeline[$p];
        $row['leads']++;
        $status = $l['status'] ?? 'open';
        if ($status === 'won') {
            $row['won']++;
            $row['revenue'] += (float)($l['price'] ?? 0);
            if (!(float)($l['price'] ?? 0)) $row['won_without_price']++;
        } elseif ($status === 'lost') $row['lost']++;
        else $row['open']++;
        unset($row);
    }
    $pipes = array_values($byPipeline);
    usort($pipes, fn($a, $b) => $b['leads'] <=> $a['leads']);

    $spend = (float)($spendByPlatform['instagram'] ?? 0);
    $adCur = (string)($spendByPlatform['currency'] ?? '');
    $rate  = (float)(cfg()['fx_rate'] ?? 0);
    $same  = $adCur !== '' && $amoCurrency !== '' && $adCur === $amoCurrency;
    $comparable = empty($spendByPlatform['mixed_currency']) && ($same || $rate > 0);
    $spendInAmo = $same ? $spend : ($rate > 0 ? $spend * $rate : null);

    $noSource = $bySource['(не указан)']['leads'] ?? 0;
    return [
        'spend' => $spendByPlatform,
        'sources' => $sources,
        'pipelines' => $pipes,
        'source_filled' => count($leads) ? (count($leads) - $noSource) / count($leads) : 0,
        'currency' => [
            'ads' => $adCur,
            'amo' => $amoCurrency,
            'same' => $same,
            'rate' => $rate > 0 ? $rate : null,
            'comparable' => $comparable,
            'mixed_ad_accounts' => (bool)($spendByPlatform['mixed_currency'] ?? false),
        ],
        'instagram' => [
            'spend' => $spend,
            'leads' => $ig['leads'],
            'won' => $ig['won'],
            'lost' => $ig['lost'],
            'open' => $ig['open'],
            'revenue' => $ig['revenue'],
            'won_without_price' => $ig['won_without_price'],
            'cost_per_lead' => $ig['leads'] ? $spend / $ig['leads'] : null,
            'cac' => ($comparable && $ig['won']) ? $spendInAmo / $ig['won'] : null,
            'roas' => ($comparable && $spendInAmo) ? $ig['revenue'] / $spendInAmo : null,
            'conv' => $ig['leads'] ? $ig['won'] / $ig['leads'] : null,
        ],
    ];
}
