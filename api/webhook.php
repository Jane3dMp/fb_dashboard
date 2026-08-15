<?php
// Приёмник вебхуков Instagram Messaging (замена проекта «IG webhook»).
//
// Ловит момент клика по рекламе: Meta кладёт в первое сообщение referral
// с ad_id — единственное место, где известно, какое объявление привело
// человека. Пишет в таблицу clicks (аналог листа «Клики»).
//
// Callback URL в Meta:  https://.../api/webhook.php?s=<webhook_secret>
// Verify Token:         meta.verify_token из config.php
//
// Отличие от Apps Script-версии: здесь доступны HTTP-заголовки, поэтому
// при заполненном meta.app_secret проверяется настоящая подпись Meta
// (X-Hub-Signature-256) — защита сильнее секрета в URL.
declare(strict_types=1);

require __DIR__ . '/lib.php';
require __DIR__ . '/db.php';

$meta = cfg()['meta'];

/* --- верификация подписки: Meta дёргает GET с hub.challenge --- */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    if (($_GET['hub_mode'] ?? $_GET['hub.mode'] ?? '') === 'subscribe'
        && ($_GET['hub_verify_token'] ?? $_GET['hub.verify_token'] ?? '') === (string)$meta['verify_token']) {
        header('Content-Type: text/plain');
        while (ob_get_level() > 0) @ob_end_clean();
        echo (string)($_GET['hub_challenge'] ?? $_GET['hub.challenge'] ?? '');
        exit;
    }
    header('Content-Type: text/plain');
    http_response_code(403);
    echo 'forbidden';
    exit;
}

/* --- входящие события --- */
// Meta не читает тело ответа, поэтому на любую ошибку отвечаем 200 и пишем
// в лог — иначе после серии неудач Meta отпишет эндпоинт.
$raw = (string)file_get_contents('php://input');

$authorized = false;
if (($_GET['s'] ?? '') === (string)$meta['webhook_secret'] && (string)$meta['webhook_secret'] !== '') {
    $authorized = true;
}
if (!empty($meta['app_secret'])) {
    $sig = (string)($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '');
    $want = 'sha256=' . hash_hmac('sha256', $raw, (string)$meta['app_secret']);
    $authorized = $sig !== '' && hash_equals($want, $sig);
}
if (!$authorized) {
    error_log('webhook: запрос без валидного секрета/подписи');
    http_response_code(200);
    exit;
}

try {
    $body = json_decode($raw, true) ?: [];
    foreach ($body['entry'] ?? [] as $entry) {
        foreach ($entry['messaging'] ?? [] as $msg) {
            $ref = $msg['referral'] ?? ($msg['postback']['referral'] ?? null);
            $igsid = (string)($msg['sender']['id'] ?? '');
            if (!$igsid) continue;
            // интересен именно приход из рекламы; обычные сообщения не пишем
            if (!$ref && empty($msg['message']['referral'])) continue;
            $r = $ref ?? $msg['message']['referral'];
            db()->prepare('INSERT INTO clicks (ts, igsid, ad_id, ref, ad_title, media_url, first_text, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)')->execute([
                date('c', (int)(($msg['timestamp'] ?? 0) / 1000) ?: time()),
                $igsid,
                (string)($r['ad_id'] ?? ''),
                (string)($r['ref'] ?? ''),
                (string)($r['ads_context_data']['ad_title'] ?? ''),
                (string)($r['ads_context_data']['photo_url'] ?? $r['ads_context_data']['video_url'] ?? ''),
                (string)($msg['message']['text'] ?? ''),
                mb_substr($raw, 0, 4000),
            ]);
        }
    }
} catch (Throwable $e) {
    error_log('webhook: ' . $e->getMessage());
}
http_response_code(200);
echo 'ok';
