<?php
// Guestbook: messages saved as JSON in DATA_DIR.
$file = (getenv('DATA_DIR') ?: __DIR__) . '/guestbook.json';
$entries = file_exists($file) ? (json_decode(file_get_contents($file), true) ?: []) : [];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $name = trim(substr($_POST['name'] ?? '', 0, 60));
    $text = trim(substr($_POST['text'] ?? '', 0, 1000));
    if ($name !== '' && $text !== '') {
        array_unshift($entries, ['name' => $name, 'text' => $text, 'at' => date('c')]);
        file_put_contents($file, json_encode(array_slice($entries, 0, 500)), LOCK_EX);
    }
    header('Location: ./', true, 303);
    exit;
}
function e($s) { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Guestbook</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
    main { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 10px; margin-bottom: 8px; font: inherit; }
    article { border-top: 1px solid GrayText; padding: 12px 0; }
    small { color: GrayText; }
  </style>
</head>
<body>
  <main>
    <h1>Guestbook</h1>
    <form method="post">
      <input name="name" placeholder="Your name" required maxlength="60">
      <textarea name="text" placeholder="Leave a message" required maxlength="1000"></textarea>
      <button>Sign the guestbook</button>
    </form>
    <?php foreach ($entries as $en): ?>
      <article><strong><?= e($en['name']) ?></strong> <small><?= e(date('j M Y, H:i', strtotime($en['at']))) ?></small><p><?= nl2br(e($en['text'])) ?></p></article>
    <?php endforeach; ?>
  </main>
</body>
</html>
