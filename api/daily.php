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

$out = [
    'view' => 'daily',
    'since' => $since,
    'until' => $until,
    'updated' => date('c'),
    'currency' => $currency,
    'mixed_currency' => $mixed,
    'days' => array_values($byDate),
];
cache_put($cacheKey, $out);
json_out($out);
