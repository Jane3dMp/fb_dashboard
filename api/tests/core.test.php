<?php
// Паритетные тесты PHP-ядра: те же сценарии, что в tests/logic.test.js
// для pplAlfaRevenueCore_. Если и JS, и PHP проходят одинаковые проверки —
// оба бэкенда считают деньги одинаково.
//
// Запуск: php api/tests/core.test.php   (выход 0 = все проверки прошли)
declare(strict_types=1);

// core.php берёт brand_map и fx_rate из cfg(); в тесте — своя копия карты
function cfg(): array {
    return [
        'fx_rate' => 2.9,
        'brand_map' => [
            'каникулы' => 'Уикенд',
            'абонементы' => 'CODDY + Прознание',
            'регулярные занятия' => 'CODDY + Прознание',
            'детали' => 'Детали',
        ],
    ];
}

require __DIR__ . '/../core.php';

$passed = 0; $failed = 0;
function ok(bool $cond, string $name, string $note = ''): void {
    global $passed, $failed;
    if ($cond) { $passed++; echo "  ok   $name\n"; }
    else { $failed++; echo "  FAIL $name" . ($note !== '' ? " — $note" : '') . "\n"; }
}

function ig_lead(array $over = []): array {
    return $over + [
        'created_at' => '2026-07-10', 'phone_e164' => '+375291102796',
        'source' => 'Instagram', 'pipeline' => 'Каникулы', 'alfa_url' => '', 'contact_id' => '',
    ];
}
function customer(int $id, string $phones, string $amoContact = ''): array {
    return ['customer_id' => $id, 'phones' => $phones, 'amo_contact_id' => $amoContact, 'name' => 'Клиент ' . $id];
}
function pay(int $cid, string $date, float $income, int $payId): array {
    return ['document_date' => $date, 'customer_id' => $cid, 'income' => $income, 'pay_id' => $payId];
}

echo "Нормализация телефона\n";
ok(norm_phone('+375(29)110-27-96') === '+375291102796', 'формат Альфы приводится к E.164');
ok(norm_phone('80291234567') === '+375291234567', '80… получает код страны');
ok(norm_phone('291234567') === '+375291234567', '9 цифр дополняются');
ok(norm_phone('335') === '', 'мусор отбраковывается');

echo "Даты\n";
ok(any_iso('15.07.2026') === '2026-07-15', 'ДД.ММ.ГГГГ разворачивается');
ok(any_iso('2026-07-15T10:00:00Z') === '2026-07-15', 'ISO обрезается до даты');
ok(any_iso('вчера') === '', 'нечитаемое даёт пусто');

echo "Ядро выручки\n";
$r = alfa_revenue_core([ig_lead()], [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 1)], '2026-07-01', '2026-07-31');
ok($r['with_alfa'] === 1 && $r['paid_customers'] === 1 && $r['revenue'] === 250.0,
    'матч по телефону, платёж после заявки считается');
ok($r['brands'][0]['brand'] === 'Уикенд', 'бренд по карте направлений');

$r = alfa_revenue_core([ig_lead()], [customer(101, '+375291102796')],
    [pay(101, '05.07.2026', 999, 1)], '2026-07-01', '2026-07-31');
ok($r['with_alfa'] === 1 && $r['revenue'] === 0.0, 'платёж раньше заявки не приписывается рекламе');

$r = alfa_revenue_core([ig_lead()],
    [customer(101, '+375291102796'), customer(102, '+375291102796')],
    [pay(101, '15.07.2026', 250, 1), pay(102, '20.07.2026', 300, 2)],
    '2026-07-01', '2026-07-31');
ok($r['paid_customers'] === 1 && $r['revenue'] === 550.0, 'семья: деньги обоих детей, но один раз');
ok(count($r['paid_list']) === 2 && $r['paid_list'][0]['revenue'] === 300.0,
    'пофамильный список: по ребёнку на строку, богатые сверху');

$r = alfa_revenue_core([ig_lead(), ig_lead(['created_at' => '2026-07-12'])],
    [customer(101, '+375291102796')], [pay(101, '15.07.2026', 250, 1)],
    '2026-07-01', '2026-07-31');
ok($r['with_alfa'] === 2 && $r['revenue'] === 250.0, 'повторная заявка деньги не задваивает');

$r = alfa_revenue_core([ig_lead()], [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 7), pay(101, '15.07.2026', 250, 7)],
    '2026-07-01', '2026-07-31');
ok($r['revenue'] === 250.0, 'дубль платежа по pay_id считается один раз');

$r = alfa_revenue_core([ig_lead(['alfa_url' => 'https://x.s20.online/#/customer/777'])],
    [customer(101, '+375291102796')],
    [pay(777, '15.07.2026', 400, 1), pay(101, '15.07.2026', 100, 2)],
    '2026-07-01', '2026-07-31');
ok($r['revenue'] === 400.0, 'ссылка на Альфу приоритетнее телефона');

$r = alfa_revenue_core([ig_lead(['phone_e164' => '', 'contact_id' => '40464221'])],
    [customer(101, '', '40464221')], [pay(101, '15.07.2026', 300, 1)],
    '2026-07-01', '2026-07-31');
ok($r['revenue'] === 300.0, 'мост по id контакта amo работает без телефона');

$r = alfa_revenue_core([ig_lead(['source' => 'Звонок'])], [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 1)], '2026-07-01', '2026-07-31');
$call = null;
foreach ($r['by_source'] as $s) if ($s['source'] === 'Звонок') $call = $s;
ok($r['revenue'] === 0.0 && $call !== null && $call['revenue'] === 250.0,
    'сводка только про Instagram, но разрез по источникам видит звонок');

$r = alfa_revenue_core([ig_lead(['created_at' => '2026-06-10'])],
    [customer(101, '+375291102796')], [pay(101, '15.07.2026', 250, 1)],
    '2026-07-01', '2026-07-31');
ok($r['leads'] === 0, 'заявка вне периода не попадает');

echo "\n$passed passed, $failed failed\n";
exit($failed ? 1 : 0);
