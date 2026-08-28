<?php
// Дашборд — endpoint «Дни таргета» (замена view=daily в Apps Script).
//
//   GET daily.php?since=ГГГГ-ММ-ДД&until=ГГГГ-ММ-ДД&key=...
//
// Дневная разбивка Meta Ads Insights: расход, показы, клики, начатые
// переписки. JSON совместим с pplBuildDaily из people.gs.
declare(strict_types=1);

require __DIR__ . '/lib.php';

cors();
require_dash_key();

$until = (string)($_GET['until'] ?? date('Y-m-d'));
$since = (string)($_GET['since'] ?? substr($until, 0, 8) . '01');

$cacheKey = 'daily_' . $since . '_' . $until;
if (($_GET['nocache'] ?? '') !== '1') {
    $hit = cache_get($cacheKey, 600);
    if ($hit !== null) json_out($hit);
}

$byDate = [];
$currency = '';
$mixed = false;
foreach (array_keys(cfg()['meta']['accounts']) as $accId) {
    $data = meta_get('/act_' . $accId . '/insights?level=account&time_increment=1'
        . '&fields=spend,impressions,clicks,inline_link_clicks,actions,account_currency'
        . '&time_range=' . urlencode(json_encode(['since' => $since, 'until' => $until]))
        . '&limit=200');
    foreach ($data['data'] ?? [] as $r) {
        $d = (string)($r['date_start'] ?? '');
        if ($d === '') continue;
        if (!isset($byDate[$d])) $byDate[$d] = ['date' => $d, 'spend' => 0.0, 'impressions' => 0, 'clicks' => 0, 'link_clicks' => 0, 'messages' => 0];
        $row = &$byDate[$d];
        $row['spend'] += (float)($r['spend'] ?? 0);
        $row['impressions'] += (int)($r['impressions'] ?? 0);
        $row['clicks'] += (int)($r['clicks'] ?? 0);
        $row['link_clicks'] += (int)($r['inline_link_clicks'] ?? 0);
        foreach ($r['actions'] ?? [] as $a) {
            if (strpos((string)($a['action_type'] ?? ''), 'messaging_conversation_started') !== false) {
                $row['messages'] += (int)($a['value'] ?? 0);
            }
        }
        unset($row);
        $cur = (string)($r['account_currency'] ?? '');
        if ($cur !== '') {
            if ($currency === '') $currency = $cur;
            elseif ($currency !== $cur) $mixed = true;
        }
    }
}
ksort($byDate);

/* --- те же дни раздельно по Instagram-профилям (профиль — из креатива) --- */
$perAd = [];
foreach (array_keys(cfg()['meta']['accounts']) as $accId) {
    $data = meta_get('/act_' . $accId . '/insights?level=ad&time_increment=1'
        . '&fields=ad_id,spend,impressions,clicks,inline_link_clicks,actions'
        . '&time_range=' . urlencode(json_encode(['since' => $since, 'until' => $until]))
        . '&limit=500');
    for ($page = 0; $page < 6; $page++) {
        foreach ($data['data'] ?? [] as $r) $perAd[] = $r;
        $next = $data['paging']['next'] ?? null;
        if (!$next) break;
        $r2 = http_json('GET', $next);           // в next токен уже вшит
        $data = $r2['code'] === 200 ? $r2['data'] : [];
    }
}

$adIds = array_values(array_unique(array_map(fn($r) => (string)($r['ad_id'] ?? ''), $perAd)));

// связка объявление → профиль и имена — те же кэши, что у people.php
$actorCache = cache_get('ig_actors', 6 * 3600) ?? [];
$actorByAd = $actorCache['map'] ?? [];
$missing = array_values(array_filter($adIds, fn($id) => $id !== '' && !array_key_exists($id, $actorByAd)));
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

$igNames = cfg()['meta']['ig_profiles'] ?? [];
$nameCache = cache_get('ig_names', 6 * 3600) ?? [];
$known = $nameCache['map'] ?? [];
$actors = array_values(array_unique(array_filter($actorByAd)));
$ask = array_values(array_filter($actors, fn($a) => !isset($igNames[$a]) && !array_key_exists($a, $known)));
if ($ask) {
    $data = meta_get('/?ids=' . urlencode(implode(',', $ask)) . '&fields=' . urlencode('username,name'));
    foreach ($ask as $id) {
        $pr = $data[$id] ?? [];
        $known[$id] = !empty($pr['username']) ? '@' . $pr['username'] : (string)($pr['name'] ?? '');
    }
    cache_put('ig_names', ['map' => $known]);
}

$byProfile = [];
foreach ($perAd as $r) {
    $actor = $actorByAd[(string)($r['ad_id'] ?? '')] ?? '';
    $key = $actor !== '' ? $actor : '(профиль не определён)';
    if (!isset($byProfile[$key])) {
        $label = $igNames[$actor] ?? (($known[$actor] ?? '') !== '' ? $known[$actor] : $key);
        $byProfile[$key] = ['profile_id' => $actor, 'profile' => $label, 'byDate' => []];
    }
    $d = (string)($r['date_start'] ?? '');
    if ($d === '') continue;
    if (!isset($byProfile[$key]['byDate'][$d])) {
        $byProfile[$key]['byDate'][$d] = ['date' => $d, 'spend' => 0.0, 'impressions' => 0, 'clicks' => 0, 'link_clicks' => 0, 'messages' => 0];
    }
    $row = &$byProfile[$key]['byDate'][$d];
    $row['spend'] += (float)($r['spend'] ?? 0);
    $row['impressions'] += (int)($r['impressions'] ?? 0);
    $row['clicks'] += (int)($r['clicks'] ?? 0);
    $row['link_clicks'] += (int)($r['inline_link_clicks'] ?? 0);
    foreach ($r['actions'] ?? [] as $a) {
        if (strpos((string)($a['action_type'] ?? ''), 'messaging_conversation_started') !== false) {
            $row['messages'] += (int)($a['value'] ?? 0);
        }
    }
    unset($row);
}
$profiles = [];
foreach ($byProfile as $p) {
    ksort($p['byDate']);
    $profiles[] = ['profile_id' => $p['profile_id'], 'profile' => $p['profile'], 'days' => array_values($p['byDate'])];
}
usort($profiles, function ($a, $b) {
    $s = fn($x) => array_sum(array_map(fn($d) => $d['spend'], $x['days']));
    return $s($b) <=> $s($a);
});

$out = [
    'view' => 'daily',
    'since' => $since,
    'until' => $until,
    'updated' => date('c'),
    'currency' => $currency,
    'mixed_currency' => $mixed,
    'days' => array_values($byDate),
    'by_profile' => $profiles,
];
cache_put($cacheKey, $out);
json_out($out);
