<?php
// Дашборд — общая библиотека: конфиг, JSON-ответы, CORS, клиенты API.
// Схема повторяет api/alfa/lib.php из finmodel-club — тот же хостинг,
// те же грабли (мусор в выводе до JSON, потерянные заголовки и т.п.).
declare(strict_types=1);

@ini_set('display_errors', '0');
@ini_set('zend.exception_ignore_args', '1');
if (function_exists('ob_start')) @ob_start();

// ---------- Конфигурация ----------
function cfg(): array {
    static $c = null;
    if ($c === null) {
        $path = __DIR__ . '/config.php';
        if (!file_exists($path)) {
            json_out(['error' => 'config.php не найден на сервере — создайте его из config.example.php'], 500);
        }
        $c = require $path;
    }
    return $c;
}

// ---------- Ответ JSON ----------
function json_out(array $data, int $code = 200): void {
    $junk = '';
    while (ob_get_level() > 0) { $junk .= (string)ob_get_clean(); }
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
    }
    $junk = trim($junk);
    if ($junk !== '') $data['serverNoise'] = mb_substr($junk, 0, 400);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if ($json === false) $json = '{"error":"Не удалось собрать ответ (битые символы в данных CRM)"}';
    echo $json;
    exit;
}

// ---------- CORS ----------
function cors(): void {
    $allowed = cfg()['allowed_origins'] ?? [];
    $origin  = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin && in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
        http_response_code(204);
        exit;
    }
}

// ---------- Пароль дашборда ----------
// Та же семантика, что DASH_KEY в doGet: пустой ключ в конфиге = пускать всех.
function require_dash_key(): void {
    $want = (string)(cfg()['dash_key'] ?? '');
    if ($want === '') return;
    if (($_GET['key'] ?? '') !== $want) json_out(['error' => 'unauthorized'], 401);
}

// ---------- HTTP ----------
function http_json(string $method, string $url, array $headers = [], ?array $body = null, int $timeout = 60): array {
    $ch = curl_init($url);
    $h = $headers;
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_FOLLOWLOCATION => true,
    ];
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE);
        $h[] = 'Content-Type: application/json';
    }
    $opts[CURLOPT_HTTPHEADER] = $h;
    curl_setopt_array($ch, $opts);
    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException('HTTP ' . $url . ': ' . $err);
    $data = json_decode((string)$raw, true);
    return ['code' => $code, 'data' => is_array($data) ? $data : [], 'raw' => (string)$raw];
}

// ---------- amoCRM ----------
function amo_get(string $path): array {
    $a = cfg()['amo'];
    $r = http_json('GET', 'https://' . $a['subdomain'] . '.amocrm.ru/api/v4' . $path,
        ['Authorization: Bearer ' . $a['token']]);
    if ($r['code'] === 204) return [];
    if ($r['code'] !== 200) throw new RuntimeException('amoCRM ' . $r['code'] . ': ' . mb_substr($r['raw'], 0, 200));
    return $r['data'];
}

// ---------- AlfaCRM ----------
function alfa_token(): string {
    static $token = null;
    if ($token === null) {
        $a = cfg()['alfa'];
        $r = http_json('POST', 'https://' . $a['hostname'] . '/v2api/auth/login', [],
            ['email' => $a['email'], 'api_key' => $a['api_key']]);
        $token = (string)($r['data']['token'] ?? '');
        if ($token === '') throw new RuntimeException('Альфа не пустила: ' . mb_substr($r['raw'], 0, 150));
    }
    return $token;
}

function alfa_page(int $branch, string $entity, array $body): array {
    $a = cfg()['alfa'];
    $r = http_json('POST', 'https://' . $a['hostname'] . '/v2api/' . $branch . '/' . $entity . '/index',
        ['X-ALFACRM-TOKEN: ' . alfa_token()], $body);
    if ($r['code'] !== 200) throw new RuntimeException('Альфа ' . $entity . '/' . $branch . ': ' . $r['code']);
    return $r['data'];
}

// ---------- Meta Graph ----------
function meta_get(string $pathAndQuery): array {
    $m = cfg()['meta'];
    $sep = (strpos($pathAndQuery, '?') === false) ? '?' : '&';
    $url = 'https://graph.facebook.com/' . $m['api_version'] . $pathAndQuery .
        $sep . 'access_token=' . urlencode($m['token']);
    $r = http_json('GET', $url);
    // кабинет мог отвалиться по правам — пусть решает вызывающий
    return $r['code'] === 200 ? $r['data'] : [];
}

// ---------- Файловый кэш (замена CacheService) ----------
function cache_dir(): string {
    $dir = __DIR__ . '/data/cache';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

function cache_get(string $key, int $ttl): ?array {
    $f = cache_dir() . '/' . preg_replace('~[^a-z0-9_-]~i', '_', $key) . '.json';
    if (!is_file($f) || time() - (int)filemtime($f) > $ttl) return null;
    $d = json_decode((string)file_get_contents($f), true);
    return is_array($d) ? $d : null;
}

function cache_put(string $key, array $data): void {
    $f = cache_dir() . '/' . preg_replace('~[^a-z0-9_-]~i', '_', $key) . '.json';
    @file_put_contents($f, json_encode($data, JSON_UNESCAPED_UNICODE), LOCK_EX);
}
