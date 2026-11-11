// file:// 无法通过 ES Module 加载本地依赖；使用同一份源码生成的普通脚本包。
(() => {
  const script = document.createElement('script');
  if (location.protocol === 'file:') {
    script.src = './app.bundle.js?v=1.1.26';
  } else {
    script.type = 'module';
    script.src = './app.js?v=1.1.26';
  }
  script.onerror = () => {
    document.getElementById('deviceInfo').textContent =
      '页面程序加载失败，请刷新重试，或检查本地下载的页面文件是否完整。';
  };
  document.body.appendChild(script);
})();
