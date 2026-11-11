// 本地文件与 HTTPS 发布使用同版本的脚本包，避免加载缓存中的旧依赖。
(() => {
  const script = document.createElement('script');
  if (location.protocol === 'http:') {
    script.type = 'module';
    script.src = './app.js?v=1.1.27';
  } else {
    script.src = './app.bundle.js?v=1.1.27';
  }
  script.onerror = () => {
    document.getElementById('deviceInfo').textContent =
      '页面程序加载失败，请刷新重试，或检查本地下载的页面文件是否完整。';
  };
  document.body.appendChild(script);
})();
