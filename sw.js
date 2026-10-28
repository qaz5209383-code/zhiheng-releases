/*
 * 知衡的 Service Worker：只做缓存与离线，不做业务。
 *
 * ## 三条禁止（01N+O §2.2，测试 N8 会断言）
 *
 * 1. 不读写任何健康数据。页面上下文之外没有作用域判据（household + person），
 *    在这里碰数据结构等于绕过 Repository 与成员隔离 —— 那是架构地基。
 * 2. 不做推送订阅、不做后台同步。推送意味着数据要离开本机才能被投递，
 *    与 Local First 冲突；真要实现也必须先有可替换的 Provider 边界。
 * 3. 不拦截业务请求。缓存层只认「构建产物 + 导航」，其余请求原样交给网络。
 *
 * ## 缓存策略
 *
 * - 导航请求（打开应用）：网络优先，失败回退到缓存的 index.html；
 *   这样离线时应用能启动，而在线时用户拿到的是最新壳。
 * - 静态资源（/assets/ 下的带哈希产物、图标、manifest）：缓存优先，
 *   回退网络并写入运行时缓存。带哈希的文件名内容不变，缓存永远不会陈旧。
 * - 其余一切：不接管。
 */

/*
 * ## 缓存版本：必须是「每次构建都不同」的
 *
 * 2026-10-26 实测的真 bug：原来这里写死 'zhiheng-shell-v1'，
 * 于是装了新版本 exe 之后，Service Worker 仍然命中**旧的**缓存条目 ——
 * 用户看到的是上一版的界面。
 *
 * 现场证据：01Y 加了「应用更新」区块，构建产物里有、exe 里也有，
 * 但设置页的 h2 列表里就是没有它。清掉 Service Worker 目录后立刻出现。
 *
 * 也就是说：**所有更新对老用户都不生效。** 这比任何单个功能 bug 都严重。
 *
 * ## 修法
 *
 * 构建时把下面的占位符替换成产物哈希（scripts/stamp-sw.mjs 做这件事）：
 * - 名称变了 → 旧缓存不在 keep 列表里 → activate 时被删掉 → 装的是新壳
 * - 名称没变（开发时直接跑 public/sw.js）→ 保持 BUILD_STAMP 原样，不炸
 */
const BUILD_STAMP = 'CmvtV79d';
const SHELL_CACHE = 'zhiheng-shell-' + BUILD_STAMP;
const RUNTIME_CACHE = 'zhiheng-runtime-' + BUILD_STAMP;

/*
 * 预缓存清单。
 *
 * 只列**构建后一定存在**的固定路径。带哈希的 assets 无法在这里穷举
 * （文件名每次构建都变），它们走运行时缓存 —— 这也是不用 workbox 注入清单的原因：
 * 那需要一个构建插件，而本轮的约束是零新依赖。
 */
/*
 * 已知的旧缓存名 —— 必须主动删掉。
 *
 * ## 为什么不能只靠 activate 里那句「不在 keep 里就删」
 *
 * 那句是对的，但它有个前提：**新 Service Worker 得先激活**。
 * 而实测（2026-10-26）的问题是反过来的：
 *
 *   旧 SW（缓存名 zhiheng-shell-v1）已经接管了页面，
 *   它用缓存里的**旧 index.html** 应答导航请求，
 *   于是页面加载的是旧主包（index-BUdZZX23.js）——
 *   旧主包里请求的 sw.js 还是旧的，浏览器比对后认为「sw.js 没变」，
 *   新 SW 永远不安装，activate 永远不跑，旧缓存永远不被删。
 *
 * 这是一个**自我维持的循环**：旧壳 → 加载旧 JS → 请求旧 sw → 不更新 → 旧壳。
 *
 * 破环的办法是让**新 SW 一旦装上就立刻清**（install 阶段），
 * 而不是等 activate。install 在 activate 之前，且新 SW 一旦被下载就会跑。
 *
 * 但更根本的一步在页面侧：见 apps/client/src/app/sw-cleanup.ts ——
 * 那里直接用 caches.delete() 删旧名，不依赖 SW 生命周期。
 */
const LEGACY_CACHE_PREFIXES = [
  'zhiheng-shell-v',   // 01C–0.1.1 之前的固定名（v1）
  'zhiheng-runtime-v',
];

const SHELL = [
  '/zhiheng-releases/',
  '/zhiheng-releases/index.html',
  '/zhiheng-releases/manifest.webmanifest',
  '/zhiheng-releases/brand/favicon.svg',
  '/zhiheng-releases/brand/app-icon.svg',
];

/** 允许缓存的静态资源判定。只认同源、且是构建产物或品牌图标。 */
function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith('/zhiheng-releases/assets/') || url.pathname.startsWith('/zhiheng-releases/brand/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      /*
       * 逐个 add 而不是 addAll：addAll 有一个失败就整批失败，
       * 而清单里任何一个文件（例如某个品牌图标没同步）缺失，
       * 都会让整个 Service Worker 装不上 —— 表现是「离线完全不可用」，
       * 而失败原因只是一张图标。
       */
      await Promise.all(
        SHELL.map((path) => cache.add(path).catch(() => undefined)),
      );

      /*
       * 装好新壳之后，立刻删掉旧名字的缓存。
       *
       * 为什么在 install 而不是 activate：见 LEGACY_CACHE_PREFIXES 上面的注释。
       * 一句话：等 activate 可能永远等不到（旧壳会一直维持自己）。
       *
       * 只删「以旧前缀开头、且不是本次的缓存名」—— 不误伤别的来源。
       */
      const existing = await caches.keys();
      const legacy = existing.filter(
        (name) =>
          name !== SHELL_CACHE &&
          name !== RUNTIME_CACHE &&
          LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)),
      );
      await Promise.all(legacy.map((name) => caches.delete(name).catch(() => undefined)));

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 导航：网络优先，离线回退到缓存的应用壳。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          /*
           * no-store：绕开 HTTP 缓存。
           *
           * 不加这一条的话，即使 Service Worker 逻辑正确、缓存名也换了，
           * WebView 的 HTTP 缓存仍可能把旧 index.html 递回来 ——
           * 那就等于白改。导航是「壳」的入口，它必须每次都是新的。
           */
          return await fetch(request, { cache: 'no-store' });
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = (await cache.match('/zhiheng-releases/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          // 连壳都没缓存到：如实返回网络错误，不伪造一个空页面。
          throw new Error('offline and no cached shell');
        }
      })(),
    );
    return;
  }

  // 静态资源：缓存优先。
  if (isCacheableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        // 只缓存成功的同源响应；不透明响应（opaque）写进去会让离线时拿到 0 字节。
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      })(),
    );
    return;
  }

  // 其余请求：不接管。业务数据与任何非静态资源都不经这里。
});
