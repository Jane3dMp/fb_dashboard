<?php
// Дашборд — endpoint «Путь клиента» (замена view=people в Apps Script).
//
//   GET people.php?days=30&key=...            — окно в днях
//   GET people.php?since=...&until=...&key=...— произвольный период
//   &nocache=1                                — пересчитать мимо кэша
//
// JSON построчно совместим с ответом buildPeople из people.gs — страница
// people.html не отличает этот бэкенд от Apps Script. Отличие одно:
// сводка по источникам берётся из SQLite (кроновая дельта раз в 15 минут),
// а не живым запросом в amo — поэтому ответ собирается за секунды.
declare(strict_types=1);

require __DIR__ . '/lib.php';
require __DIR__ . '/db.php';
require __DIR__ . '/core.php';

cors();
require_dash_key();
@set_time_limit(120);

$until = (string)($_GET['until'] ?? date('Y-m-d'));
$since = (string)($_GET['since'] ?? date('Y-m-d', time() - 86400 * max(1, (int)($_GET['days'] ?? 30))));

$cacheKey = 'people_' . $since . '_' . $until;
if (($_GET['nocache'] ?? '') !== '1') {
    $hit = cache_get($cacheKey, 600);
    if ($hit !== null) json_out($hit);
}

/* ---------- Meta: расход ---------- */

function meta_accounts(): array {
    return array_map(fn($id) => 'act_' . $id, array_keys(cfg()['meta']['accounts']));
}

function spend_by_ad(string $since, string $until): array {
    $spend = [];
    foreach (meta_accounts() as $acct) {
        $data = meta_get('/' . $acct . '/insights?level=ad&fields=ad_id,ad_name,campaign_name,spend,clicks,impressions'
            . '&time_range=' . urlencode(json_encode(['since' => $since, 'until' => $until]))
            . '&limit=500');
        foreach ($data['data'] ?? [] as $r) {
            $spend[$r['ad_id']] = [
                'ad_name' => $r['ad_name'] ?? '',
                'campaign_name' => $r['campaign_name'] ?? '',
                'spend' => (float)($r['spend'] ?? 0),
                'clicks' => (int)($r['clicks'] ?? 0),
                'impressions' => (int)($r['impressions'] ?? 0),
            ];
        }
    }
    return $spend;
}

function spend_by_platform(string $since, string $until): array {
    $out = ['instagram' => 0.0, 'facebook' => 0.0, 'other' => 0.0, 'total' => 0.0, 'currency' => '', 'mixed_currency' => false];
    foreach (meta_accounts() as $acct) {
        $data = meta_get('/' . $acct . '/insights?level=account&fields=spend,account_currency&breakdowns=publisher_platform'
            . '&time_range=' . urlencode(json_encode(['since' => $since, 'until' => $until]))
            . '&limit=100');
        foreach ($data['data'] ?? [] as $r) {
            $v = (float)($r['spend'] ?? 0);
            $p = strtolower((string)($r['publisher_platform'] ?? ''));
            $cur = (string)($r['account_currency'] ?? '');
            if ($cur !== '') {
                if ($out['currency'] === '') $out['currency'] = $cur;
                elseif ($out['currency'] !== $cur) $out['mixed_currency'] = true;
            }
            $out['total'] += $v;
            if ($p === 'instagram') $out['instagram'] += $v;
            elseif ($p === 'facebook') $out['facebook'] += $v;
            else $out['other'] += $v;
        }
    }
    return $out;
}

function spend_by_profile(array $spendByAd): array {
    $names = cfg()['meta']['ig_profiles'] ?? [];

    // креатив объявления не меняется — связку ad→profile держим в кэше долго
    $actorCache = cache_get('ig_actors', 6 * 3600) ?? [];
    $actorByAd = $actorCache['map'] ?? [];
    $missing = array_values(array_filter(array_keys($spendByAd), fn($id) => !array_key_exists($id, $actorByAd)));
    for ($i = 0; $i < count($missing); $i += 25) {
        $chunk = array_slice($missing, $i, 25);
        $data = meta_get('/?ids=' . urlencode(implode(',', $chunk))
            . '&fields=' . urlencode('creative{instagram_actor_id,instagram_user_id}'));
        foreach ($chunk as $id) {
            $cr = $data[$id]['creative'] ?? [];
            $actorByAd[$id] = (string)($cr['instagram_user_id'] ?? $cr['instagram_actor_id'] ?? '');
        }
    }
    if ($missing) cache_put('ig_actors', ['map' => $actorByAd]);

    // username профилей — тоже из Meta, IG_PROFILES из конфига побеждает
    $nameCache = cache_get('ig_names', 6 * 3600) ?? [];
    $known = $nameCache['map'] ?? [];
    $actors = array_values(array_unique(array_filter($actorByAd)));
    $ask = array_values(array_filter($actors, fn($a) => !isset($names[$a]) && !array_key_exists($a, $known)));
    if ($ask) {
        $data = meta_get('/?ids=' . urlencode(implode(',', $ask)) . '&fields=' . urlencode('username,name'));
        foreach ($ask as $id) {
            $p = $data[$id] ?? [];
            $known[$id] = !empty($p['username']) ? '@' . $p['username'] : (string)($p['name'] ?? '');
        }
        cache_put('ig_names', ['map' => $known]);
    }

    $acc = [];
    foreach ($spendByAd as $adId => $s) {
        $actor = $actorByAd[$adId] ?? '';
        $key = $actor !== '' ? $actor : '(профиль не определён)';
        if (!isset($acc[$key])) {
            $label = $names[$actor] ?? (($known[$actor] ?? '') !== '' ? $known[$actor] : $key);
            $acc[$key] = ['profile_id' => $actor, 'profile' => $label, 'spend' => 0.0, 'clicks' => 0, 'ads' => 0];
        }
        $acc[$key]['spend'] += $s['spend'];
        $acc[$key]['clicks'] += $s['clicks'];
        $acc[$key]['ads']++;
    }
    $out = array_values($acc);
    usort($out, fn($a, $b) => $b['spend'] <=> $a['spend']);
    return $out;
}

function amo_currency(): string {
    $c = cache_get('amo_currency', 12 * 3600);
    if ($c !== null) return (string)($c['cur'] ?? '');
    try { $cur = strtoupper((string)(amo_get('/account')['currency'] ?? '')); }
    catch (Throwable $e) { $cur = ''; }
    cache_put('amo_currency', ['cur' => $cur]);
    return $cur;
}

/* ---------- Сборка ответа ---------- */

try {
    $leads = db()->query('SELECT * FROM leads')->fetchAll(PDO::FETCH_ASSOC);
    $customers = db()->query('SELECT * FROM customers')->fetchAll(PDO::FETCH_ASSOC);
    $pays = db()->query('SELECT * FROM pays')->fetchAll(PDO::FETCH_ASSOC);

    $spendByAd = spend_by_ad($since, $until);
    $byPlatform = spend_by_platform($since, $until);
    $amoCur = amo_currency();

    // сводка канала — по заявкам периода из БД
    $inPeriod = array_values(array_filter($leads, function ($l) use ($since, $until) {
        $d = any_iso($l['created_at'] ?? '');
        return $d >= $since && $d <= $until;
    }));
    $channel = channel_summary($inPeriod, $byPlatform, $amoCur);

    // деньги
    $core = alfa_revenue_core($leads, $customers, $pays, $since, $until);
    $spend = (float)($byPlatform['instagram'] ?? 0);
    $adCur = (string)($byPlatform['currency'] ?? '');
    $rate = (float)(cfg()['fx_rate'] ?? 0);
    $same = $adCur !== '' && $amoCur !== '' && $adCur === $amoCur;
    $comparable = empty($byPlatform['mixed_currency']) && ($same || $rate > 0);
    $spendInAmo = $same ? $spend : ($rate > 0 ? $spend * $rate : null);

    $revenue = [
        'source' => 'alfa',
        'mode' => count($customers) ? 'phone' : 'no_customers',
        'leads' => $core['leads'],
        'with_phone' => $core['with_phone'],
        'with_alfa' => $core['with_alfa'],
        'matched_share' => $core['matched_share'],
        'paid_customers' => $core['paid_customers'],
        'revenue' => $core['revenue'],
        'cac' => ($comparable && $core['paid_customers']) ? $spendInAmo / $core['paid_customers'] : null,
        'roas' => ($comparable && $spendInAmo) ? $core['revenue'] / $spendInAmo : null,
        'brands' => $core['brands'],
        'by_source' => $core['by_source'],
        'by_pipeline' => $core['by_pipeline'],
        'paid_list' => $core['paid_list'],
    ];

    // объявления: расход есть всегда; связка «клик → человек» появится,
    // когда вебхук начнёт получать реальные события (после App Review)
    $ads = [];
    foreach ($spendByAd as $adId => $s) {
        $ads[] = [
            'ad_id' => (string)$adId,
            'ad_name' => $s['ad_name'],
            'campaign_name' => $s['campaign_name'],
            'spend' => $s['spend'],
            'clicks' => $s['clicks'],
            'wrote' => 0, 'deals' => 0, 'won' => 0, 'revenue' => 0,
            'cac' => null,
            'roas' => $s['spend'] ? 0 / $s['spend'] : null,
        ];
    }
    usort($ads, fn($a, $b) => $b['spend'] <=> $a['spend']);

    $out = [
        'view' => 'people',
        'since' => $since,
        'until' => $until,
        'updated' => date('c'),
        'matching' => 'time',
        'people' => [],   // включится вместе с вебхуком после App Review
        'ads' => $ads,
        'channel' => $channel,
        'profiles' => spend_by_profile($spendByAd),
        'revenue' => $revenue,
    ];

    cache_put($cacheKey, $out);
    // cache_get смотрит на mtime файла, поэтому свежезаписанный кэш валиден
    json_out($out);
} catch (Throwable $e) {
    json_out(['error' => $e->getMessage()], 500);
}
