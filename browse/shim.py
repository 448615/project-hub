# -*- coding: utf-8 -*-
"""browse.shim — 注入到代理页里的那段脚本（原 _SHIM 字符串）

只做 iframe 自己搞不定的事：
  1) window.open / target=_blank 的链接改为「在窗口内跳转」（拦截新标签页）；
  2) 站点用 JS 拼出来的根相对链接（/foo）会掉到枢纽根目录 404，纠正回上游；
  3) SPA 用 pushState 换地址时把真实网址报给父窗口，地址栏才跟得上。
另外垫了 localStorage/sessionStorage 的内存实现（沙箱里访问会抛 SecurityError），
并把跨域 fetch / XHR 改写成同源代理地址。普通链接不做拦截，保留站点原生 SPA 路由。

回传给父窗口的消息统一带 __hubBrowse: 1，字段含义：
  nav  —— 请父窗口导航到这个真实网址（站内跳转 / _blank 链接）
  open —— Ctrl+点击 / 中键点击：请在新标签打开，当前页不跳走
  here —— 当前真实网址变了（pushState），地址栏跟随
  title/icon —— 文档标题与站点图标，标签页据此显示「图标 + 真实标题」
  dl   —— 触发了下载，父窗口弹 toast
  key  —— 页面内按下了浏览器快捷键（iframe 的按键不会冒泡给父窗口）
"""
from __future__ import annotations

SHIM_JS = r"""
(function(){
  try {
    var CUR = __CUR__;
    var KEY = __KEY__;
    // 服务端若没读到（网关已把参数剔掉），退一步从本文档自己的地址里取
    var SHARE = __SHARE__;
    try {
      if (!SHARE) SHARE = new URLSearchParams(location.search).get("sharecode") || "";
    } catch (e) { /* 老内核忽略 */ }
    // 云端平台的分享码门禁：沙箱 iframe 里第三方 Cookie 会被拦，
    // 子资源请求只能靠 URL 上的 sharecode 过网关（实测网关认这个参数）。
    // _hs 是给服务端自己看的副本（网关会剔掉 sharecode，剔不动 _hs）。
    function withShare(u){
      if (!SHARE) return u;
      var sep = u.indexOf("?") >= 0 ? "&" : "?";
      return u + sep + "sharecode=" + encodeURIComponent(SHARE) + "&_hs=" + encodeURIComponent(SHARE);
    }
    function stripShare(u){
      if (!SHARE || String(u).indexOf("sharecode=") < 0) return u;
      var s = String(u), h = s, hash = "";
      var k = h.indexOf("#");
      if (k >= 0) { hash = h.slice(k); h = h.slice(0, k); }
      var q = h.indexOf("?");
      if (q < 0) return u;
      var parts = h.slice(q + 1).split("&").filter(function(p){
        return p && p.indexOf("sharecode=") !== 0 && p.indexOf("_hs=") !== 0;
      });
      return h.slice(0, q) + (parts.length ? "?" + parts.join("&") : "") + hash;
    }
    // 代理页是「不透明源」文档，location.origin 会返回字符串 "null"，
    // 所以这里自己拼 origin；host 在沙箱里仍然可读。
    var ORIGIN = location.protocol + "//" + location.host;
    var BROWSE = "/browse/" + (KEY ? KEY + "/" : "");
    var PFX = ORIGIN + BROWSE;
    // 沙箱里 localStorage / sessionStorage 的访问会抛 SecurityError，
    // 很多站点一进站就读它，不垫一层会整页白屏。用内存实现顶上：
    // 只在本页面生命周期内有效（刷新即失），够站点初始化用。
    function memStore(){
      var m = {};
      var api = {
        getItem: function(k){ k = String(k); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
        setItem: function(k, v){ m[String(k)] = String(v); },
        removeItem: function(k){ delete m[String(k)]; },
        clear: function(){ m = {}; },
        key: function(i){ return Object.keys(m)[i] || null; }
      };
      Object.defineProperty(api, "length", { get: function(){ return Object.keys(m).length; } });
      return api;
    }
    ["localStorage", "sessionStorage"].forEach(function(k){
      try {
        var ok = false;
        try { ok = !!(window[k] && (window[k].setItem("__probe", "1"), window[k].removeItem("__probe"), true)); } catch(e){ ok = false; }
        if (!ok) throw new Error("blocked");
      } catch (e) {
        try { Object.defineProperty(window, k, { value: memStore(), configurable: true, writable: true }); } catch (e2) {}
      }
    });
    // 相对地址以「当前代理地址」为基准解析：/browse/xxx 会正确落回代理，
    // 而 ./a.js 也能解析成 /browse/<真实目录>/a.js（不能以 CUR 为基准，
    // 否则 /browse/… 会被解析成「真实站点/browse/…」导致重复前缀）。
    function abs(u){ try { return new URL(u, location.href).href; } catch(e){ return null; } }
    function real(u){
      var a = abs(u); if (!a) return null;
      if (a.indexOf(PFX) === 0) return stripShare(a.slice(PFX.length));
      try { var p = new URL(a); } catch(e){ return stripShare(a); }
      if (p.origin === ORIGIN) return stripShare(new URL(p.pathname + p.search + p.hash, CUR).href);
      return stripShare(a);
    }
    // 所有回传都走这一个出口，保证 __hubBrowse 标记不会漏
    function post(o){ try { o.__hubBrowse = 1; parent.postMessage(o, "*"); } catch(e){} }
    function go(u){ var r = real(u); if (r) post({ nav: r }); }
    // 站点脚本被改写后调用的跳转入口（见 rewrite_js）。指向「当前页面的官方网址」
    // 的跳转属于防仿冒自跳转，忽略即可，否则会在代理里反复重定向。
    window.__hubGo = function(u){
      var r = real(u);
      if (!r || r === CUR) return;
      post({ nav: r });
    };
    // 跨域 AJAX 会被浏览器的 CORS 拦住（站点接口只认自家 Origin）。
    // 这里把 ajax 目标改写成同源代理地址，由服务端带着页面 Referer 转发。
    function proxify(u){
      try {
        var a = new URL(u, CUR);
        if (!/^https?:$/.test(a.protocol)) return null;
        if (a.origin === ORIGIN) return null;
        return withShare(BROWSE + a.href);
      } catch(e){ return null; }
    }
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function(input, init){
        try {
          var raw = (typeof input === "string") ? input : (input && input.url) || "";
          var p = proxify(raw);
          if (p) {
            var h = new Headers((init && init.headers) || (input && input.headers) || undefined);
            h.set("X-Hub-Ref", CUR);
            // 不透明源下浏览器不会自动带 Cookie，凭据模式必须显式 omit，
            // 否则 cross-origin + ACAO:* 的组合会被浏览器直接拒绝。
            init = Object.assign({}, init || {}, { headers: h, credentials: "omit" });
            if (typeof input !== "string" && input && input.method) init.method = init.method || input.method;
            input = p;
          }
        } catch(e){}
        return _fetch.call(this, input, init);
      };
    }
    var _xopen = XMLHttpRequest.prototype.open, _xsend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u){
      try {
        var p = proxify(String(u));
        if (p) { this.__hubXhr = true; arguments[1] = p; }
      } catch(e){}
      return _xopen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(){
      try { if (this.__hubXhr) this.setRequestHeader("X-Hub-Ref", CUR); } catch(e){}
      return _xsend.apply(this, arguments);
    };
    function anchorOf(ev){
      try { return ev.target && ev.target.closest ? ev.target.closest("a[href]") : null; } catch(e){ return null; }
    }
    function usableHref(a){
      var h = (a && a.getAttribute("href")) || "";
      if (!h || h.charAt(0) === "#" || /^(javascript|mailto|tel|data):/i.test(h)) return "";
      return h;
    }
    // 下载判定：带 download 属性，或指向常见二进制/归档后缀。
    // 命中就只上报、不拦截 —— 让浏览器照常落盘，父窗口弹一句「已开始下载」。
    var DL_RE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|exe|msi|dmg|pkg|deb|rpm|apk|iso|epub|xlsx?|docx?|pptx?|csv|mp4|m4v|mkv|avi|mov|mp3|flac|wav|ogg)(\?|#|$)/i;
    document.addEventListener("click", function(ev){
      var a = anchorOf(ev);
      var h = usableHref(a);
      if (!h) return;
      // Ctrl / Cmd / 中键点击：新标签打开，当前页保持不动
      if (ev.button === 1 || ev.metaKey || ev.ctrlKey) {
        var r0 = real(h);
        if (r0) { ev.preventDefault(); ev.stopPropagation(); post({ open: r0 }); }
        return;
      }
      if (ev.button !== 0 || ev.shiftKey || ev.altKey) return;
      if (a.hasAttribute("download") || DL_RE.test(h)) { post({ dl: h }); return; }
      var t = (a.getAttribute("target") || "").toLowerCase();
      var u = abs(h); if (!u) return;
      if (t === "_blank" || t === "_new") { ev.preventDefault(); ev.stopPropagation(); go(h); return; }
      // 链接不是「已经改写过的代理地址」时（站点 JS 动态生成的绝对网址最常见），
      // 原生跳转会真的离开代理 → 被目标站的反嵌入策略拦成空白。
      // 统一改由父窗口重新导航，保证永远留在代理里。
      if (u.indexOf(PFX) !== 0) {
        ev.preventDefault(); ev.stopPropagation(); go(h);
      }
    }, true);
    // 中键按下会触发自动滚动光标，中键松开默认还要导航一次：两处都拦掉
    document.addEventListener("mousedown", function(ev){
      if (ev.button !== 1) return;
      if (anchorOf(ev)) ev.preventDefault();
    }, true);
    document.addEventListener("auxclick", function(ev){
      if (ev.button !== 1) return;
      var a = anchorOf(ev);
      var h = usableHref(a);
      if (!h) return;
      ev.preventDefault();
      var r = real(h);
      if (r) post({ open: r });
    }, true);
    var _open = window.open;
    window.open = function(u){ if (u) go(u); return null; };
    function report(u){ post({ here: u }); }

    // ---- 标题 / 站点图标 ----
    // 代理页是不透明源，父窗口读不到 contentDocument.title，只能由这里主动上报。
    // 监听 <head> 的变化（SPA 改标题很常见），再用 1.5 秒轮询兜底异步改标题的站点。
    var LAST_T = "", LAST_I = "";
    function pickIcon(){
      try {
        var l = document.querySelector('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]');
        if (!l) return "";
        var href = l.getAttribute("href") || "";
        if (!href) return "";
        return abs(href) || "";
      } catch(e){ return ""; }
    }
    function sendMeta(){
      try {
        var t = String(document.title || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (t && t !== LAST_T) { LAST_T = t; post({ title: t }); }
        var i = pickIcon();
        if (i && i !== LAST_I) { LAST_I = i; post({ icon: i }); }
      } catch(e){}
    }
    try {
      var head = document.head || document.documentElement;
      var mo = new MutationObserver(sendMeta);
      mo.observe(head, { childList: true, subtree: true, characterData: true });
    } catch(e){}
    document.addEventListener("DOMContentLoaded", sendMeta);
    window.addEventListener("load", sendMeta);
    setInterval(sendMeta, 1500);

    // ---- 快捷键 ----
    // iframe 里的按键不会冒泡到父窗口，这里把「浏览器级」组合键转发过去。
    document.addEventListener("keydown", function(ev){
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var k = String(ev.key || "").toLowerCase();
      var name = "";
      if (ev.shiftKey && k === "t") name = "ctrl+shift+t";
      else if (!ev.shiftKey && !ev.altKey) {
        if (k === "l") name = "ctrl+l";
        else if (k === "t") name = "ctrl+t";
        else if (k === "w") name = "ctrl+w";
        else if (k === "r") name = "ctrl+r";
        else if (k === "d") name = "ctrl+d";
      }
      if (!name) return;
      ev.preventDefault();
      post({ key: name });
    }, true);
    ["pushState", "replaceState"].forEach(function(k){
      var f = history[k];
      if (typeof f !== "function") return;
      history[k] = function(s, t, u){ var r = f.apply(this, arguments); if (u) { var n = abs(u); if (n) report(n); } return r; };
    });
  } catch (e) {}
})();
"""
