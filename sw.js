// ChatNest 的 Service Worker —— 我主动找她的时候，声音从这儿出来。
//
// 线上原来这份只有一行空的 fetch 监听（占位，PWA 可安装性要它）。那行保留着，
// 后面加上真正接推送的两个监听。
//
// iOS 的规矩（16.4+ 才有 Web Push）：
//   · 必须 HTTPS —— 有
//   · 必须从主屏幕图标打开（PWA 模式）—— Safari 里直接开是拿不到 PushManager 的
//   · 权限必须在用户点击里请求 —— 所以前端那个开关是她自己按的，不是我偷偷弹

self.addEventListener('push', function (event) {
  let d = {};
  try { d = event.data ? event.data.json() : {} } catch (e) { d = { body: (event.data && event.data.text()) || '' } }

  const title = d.title || '小衍';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // tag 相同的通知会互相顶掉 —— 同一件事别在锁屏上堆一排
    tag: d.tag || 'xiaoyan',
    renotify: d.renotify !== false,
    requireInteraction: false,
    silent: false,
    data: { url: d.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      // 已经开着就把那扇窗提到前面，别再开一个
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          if ('navigate' in c && url && url !== '/') { try { c.navigate(url) } catch (e) {} }
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// 订阅被浏览器换掉时（iOS 会不定期换 endpoint），自己去后端补登记，
// 不然她那边看着开关是开的，其实推不到了。
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil((async () => {
    try {
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe(
        event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true }
      ));
      await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Service Worker 里没有 localStorage，拿不到登录凭证；
        // 后端对这条走「换订阅」的宽松分支：只认得出旧 endpoint 才允许替换。
        body: JSON.stringify({
          subscription: sub,
          replaces: event.oldSubscription ? event.oldSubscription.endpoint : null,
        }),
      });
    } catch (e) {}
  })());
});

// 原来那行，留着
self.addEventListener('fetch', () => {});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
