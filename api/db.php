<?php
// Дашборд — хранилище. SQLite вместо Google Sheets: файл в data/,
// прав на MySQL не нужно, бэкап = скачать один файл.
declare(strict_types=1);

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dir = __DIR__ . '/data';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        $pdo = new PDO('sqlite:' . $dir . '/dashboard.sqlite');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA journal_mode=WAL');   // читатели не ждут писателя-крона
        db_migrate($pdo);
    }
    return $pdo;
}

function db_migrate(PDO $pdo): void {
    // Схема повторяет листы таблицы «ФейсБук» — те же поля, те же имена.
    $pdo->exec('CREATE TABLE IF NOT EXISTS leads (
        lead_id      INTEGER PRIMARY KEY,
        created_at   TEXT,     -- ISO 8601
        updated_at   INTEGER,  -- unix, для дельты
        phone_e164   TEXT,
        source       TEXT,
        utm_source   TEXT,
        utm_campaign TEXT,
        utm_content  TEXT,
        fbclid       TEXT,
        pipeline     TEXT,
        stage        TEXT,
        alfa_url     TEXT,
        contact_id   TEXT,
        status       TEXT,   -- won | lost | open (по системным статусам amo)
        price        REAL    -- поле «Бюджет» сделки; НЕ деньги, только для сводки статусов
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_leads_created ON leads(created_at)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS pays (
        pay_id        INTEGER PRIMARY KEY,
        document_date TEXT,    -- ГГГГ-ММ-ДД (нормализуем при записи)
        customer_id   INTEGER,
        income        REAL,
        branch        INTEGER,
        pay_item_id   TEXT,
        payer_name    TEXT
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS ix_pays_customer ON pays(customer_id)');

    $pdo->exec('CREATE TABLE IF NOT EXISTS customers (
        customer_id    INTEGER PRIMARY KEY,
        branches       TEXT,
        phones         TEXT,   -- нормализованные, через ;
        amo_contact_id TEXT,
        created_at     TEXT,
        name           TEXT
    )');

    // клики из вебхука Instagram (лист «Клики» в старой схеме)
    $pdo->exec('CREATE TABLE IF NOT EXISTS clicks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT,
        igsid      TEXT,
        ad_id      TEXT,
        ref        TEXT,
        ad_title   TEXT,
        media_url  TEXT,
        first_text TEXT,
        raw        TEXT
    )');

    // служебное: отметки о прогонах ETL
    $pdo->exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
}

function kv_get(string $k): string {
    $st = db()->prepare('SELECT v FROM kv WHERE k = ?');
    $st->execute([$k]);
    return (string)($st->fetchColumn() ?: '');
}

function kv_set(string $k, string $v): void {
    db()->prepare('INSERT INTO kv (k, v) VALUES (?, ?)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v')->execute([$k, $v]);
}

/** Пакетный upsert: строки-ассоциативы, ключ — первое поле. */
function db_upsert(string $table, array $cols, array $rows): int {
    if (!$rows) return 0;
    $pdo = db();
    $ph = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
    $updates = implode(',', array_map(
        fn($c) => "$c = excluded.$c",
        array_slice($cols, 1)
    ));
    $sql = 'INSERT INTO ' . $table . ' (' . implode(',', $cols) . ') VALUES ' . $ph .
        ' ON CONFLICT(' . $cols[0] . ') DO UPDATE SET ' . $updates;
    $st = $pdo->prepare($sql);
    $pdo->beginTransaction();
    $n = 0;
    foreach ($rows as $r) {
        $vals = [];
        foreach ($cols as $c) $vals[] = $r[$c] ?? null;
        $st->execute($vals);
        $n++;
    }
    $pdo->commit();
    return $n;
}
