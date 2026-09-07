<?php
// Дашборд — endpoint «Сейчас активно» (замена part=active в Apps Script).
//
//   GET daily.php?part=active&key=...      (или напрямую active.php)
//
// Дерево кампания → группа → объявление из того, что Meta прямо сейчас
// доставляет, с дневным бюджетом и цифрами за сегодня и за 7 дней.
// JSON совместим с pplBuildActive из people.gs.
//
// Активность берём у Meta, а не выводим из расхода: объявление могли
// включить час назад и оно ещё ничего не потратило, а вчерашний лидер
// может быть уже выключен. Фильтр effective_status=ACTIVE учитывает и
// родителей — выключенная кампания забирает с собой все свои объявления.
declare(strict_types=1);

require_once __DIR__ . '/lib.php';

cors();
require_dash_key();

// Кэш короткий: страницу открывают именно чтобы увидеть, что происходит
// сейчас, и получасовой кэш здесь врал бы по смыслу.
if (($_GET['nocache'] ?? '') !== '1') {
    $hit = cache_get('active_now', 300);
    if ($hit !== null) json_out($hit);
}

$currency = '';
$mixed = false;
$campaigns = [];      // campaign_id => кампания с группами и объявлениями
$adIds = [];
$today = [];
$week = [];

foreach (cfg()['meta']['accounts'] as $accId => $accLabel) {
    $info = meta_get('/act_' . $accId . '?fields=currency,name');
    $cur = (string)($info['currency'] ?? '');
    if ($cur !== '') {
        if ($currency === '') $currency = $cur;
        elseif ($currency !== $cur) $mixed = true;
    }
    $acctName = (string)($info['name'] ?? '') !== '' ? (string)$info['name'] : (string)$accLabel;

    // 1. что сейчас доставляется
    $ads = meta_get_all('/act_' . $accId . '/ads?effective_status=' . urlencode('["ACTIVE"]')
        . '&fields=' . urlencode('id,name,created_time,'
            . 'campaign{id,name,objective,daily_budget,lifetime_budget},'
            . 'adset{id,name,daily_budget,lifetime_budget,start_time,end_time}')
        . '&limit=200', 5);
    foreach ($ads as $a) {
        $camp = $a['campaign'] ?? [];
        $set = $a['adset'] ?? [];
        $cid = (string)($camp['id'] ?? '') !== '' ? (string)$camp['id'] : '(без кампании)';
        if (!isset($campaigns[$cid])) {
            $campaigns[$cid] = [
                'campaign_id' => (string)($camp['id'] ?? ''),
                'campaign_name' => (string)($camp['name'] ?? '(кампания без названия)'),
                'objective' => (string)($camp['objective'] ?? ''),
                'account' => $acctName,
                'daily_budget' => meta_budget($camp['daily_budget'] ?? 0),
                'lifetime_budget' => meta_budget($camp['lifetime_budget'] ?? 0),
                'adsets' => [],
            ];
        }
        $sid = (string)($set['id'] ?? '') !== '' ? (string)$set['id'] : '(без группы)';
        if (!isset($campaigns[$cid]['adsets'][$sid])) {
            $campaigns[$cid]['adsets'][$sid] = [
                'adset_id' => (string)($set['id'] ?? ''),
                'adset_name' => (string)($set['name'] ?? '(группа без названия)'),
                'daily_budget' => meta_budget($set['daily_budget'] ?? 0),
                'lifetime_budget' => meta_budget($set['lifetime_budget'] ?? 0),
                'start_time' => (string)($set['start_time'] ?? ''),
                'end_time' => (string)($set['end_time'] ?? ''),
                'ads' => [],
            ];
        }
        $campaigns[$cid]['adsets'][$sid]['ads'][] = [
            'ad_id' => (string)($a['id'] ?? ''),
            'ad_name' => (string)($a['name'] ?? ($a['id'] ?? '')),
            'created_time' => (string)($a['created_time'] ?? ''),
        ];
        $adIds[(string)($a['id'] ?? '')] = true;
    }

    // 2. цифры: сегодня и за последние 7 дней
    foreach (['today', 'last_7d'] as $preset) {
        $rows = meta_get_all('/act_' . $accId . '/insights?level=ad&date_preset=' . $preset
            . '&fields=ad_id,spend,impressions,clicks,inline_link_clicks,actions&limit=500', 5);
        foreach ($rows as $r) {
            $id = (string)($r['ad_id'] ?? '');
            if ($id === '') continue;
            if ($preset === 'today') {
                $today[$id] = metrics_add($today[$id] ?? metrics_zero(), $r);
            } else {
                $week[$id] = metrics_add($week[$id] ?? metrics_zero(), $r);
            }
        }
    }
}
unset($adIds['']);

/* --- имена Instagram-профилей: те же кэши, что у daily.php --- */
$actorCache = cache_get('ig_actors', 6 * 3600) ?? [];
$actorByAd = $actorCache['map'] ?? [];
$missing = array_values(array_filter(array_keys($adIds), fn($id) => !array_key_exists($id, $actorByAd)));
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

/* --- сборка дерева --- */
$outCampaigns = [];
foreach ($campaigns as $c) {
    $adsets = [];
    foreach ($c['adsets'] as $s) {
        foreach ($s['ads'] as $i => $a) {
            $actor = $actorByAd[$a['ad_id']] ?? '';
            $label = $igNames[$actor] ?? (($known[$actor] ?? '') !== '' ? $known[$actor] : $actor);
            $s['ads'][$i]['profile_id'] = $actor;
            $s['ads'][$i]['profile'] = $actor !== '' ? $label : '';
            $s['ads'][$i]['today'] = $today[$a['ad_id']] ?? metrics_zero();
            $s['ads'][$i]['week'] = $week[$a['ad_id']] ?? metrics_zero();
        }
        usort($s['ads'], fn($x, $y) => $y['week']['spend'] <=> $x['week']['spend']);
        $s['today'] = metrics_sum(array_column($s['ads'], 'today'));
        $s['week'] = metrics_sum(array_column($s['ads'], 'week'));
        $adsets[] = $s;
    }
    usort($adsets, fn($x, $y) => $y['week']['spend'] <=> $x['week']['spend']);

    // при CBO бюджет задан на кампании, а у групп нули — тогда берём его
    $setsBudget = array_sum(array_column($adsets, 'daily_budget'));
    $outCampaigns[] = [
        'campaign_id' => $c['campaign_id'],
        'campaign_name' => $c['campaign_name'],
        'objective' => $c['objective'],
        'account' => $c['account'],
        'daily_budget' => $c['daily_budget'] > 0 ? $c['daily_budget'] : $setsBudget,
        'budget_on_campaign' => $c['daily_budget'] > 0,
        'lifetime_budget' => $c['lifetime_budget'],
        'adsets' => $adsets,
        'ads_count' => array_sum(array_map(fn($s) => count($s['ads']), $adsets)),
        'today' => metrics_sum(array_column($adsets, 'today')),
        'week' => metrics_sum(array_column($adsets, 'week')),
    ];
}
usort($outCampaigns, fn($a, $b) => $b['week']['spend'] <=> $a['week']['spend']);

$out = [
    'view' => 'active',
    'updated' => date('c'),
    'currency' => $currency,
    'mixed_currency' => $mixed,
    'campaigns' => $outCampaigns,
    'totals' => [
        'campaigns' => count($outCampaigns),
        'adsets' => array_sum(array_map(fn($c) => count($c['adsets']), $outCampaigns)),
        'ads' => array_sum(array_column($outCampaigns, 'ads_count')),
        'daily_budget' => array_sum(array_column($outCampaigns, 'daily_budget')),
        'today' => metrics_sum(array_column($outCampaigns, 'today')),
        'week' => metrics_sum(array_column($outCampaigns, 'week')),
    ],
    'partial' => false,
];
cache_put('active_now', $out);
json_out($out);
