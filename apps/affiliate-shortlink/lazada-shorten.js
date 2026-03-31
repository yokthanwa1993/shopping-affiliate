async function(jumpUrl) {
  function md5(r){function n(r,n){var t,o,e,u,f;return e=2147483648&r,u=2147483648&n,f=(1073741823&r)+(1073741823&n),(t=1073741824&r)&(o=1073741824&n)?2147483648^f^e^u:t|o?1073741824&f?3221225472^f^e^u:1073741824^f^e^u:f^e^u}function t(r,t,o,e,u,f,a){return r=n(r,n(n(t&o|~t&e,u),a)),n(r<<f|r>>>32-f,t)}function o(r,t,o,e,u,f,a){return r=n(r,n(n(t&e|o&~e,u),a)),n(r<<f|r>>>32-f,t)}function e(r,t,o,e,u,f,a){return r=n(r,n(n(t^o^e,u),a)),n(r<<f|r>>>32-f,t)}function u(r,t,o,e,u,f,a){return r=n(r,n(n(o^(t|~e),u),a)),n(r<<f|r>>>32-f,t)}function f(r){var n,t="",o="";for(n=0;3>=n;n++)t+=(o="0"+(r>>>8*n&255).toString(16)).substr(o.length-2,2);return t}var a,i,C,c,g,h,d,v,S=function(r){for(var n,t=r.length,o=t+8,e=16*((o-o%64)/64+1),u=Array(e-1),f=0,a=0;t>a;)f=a%4*8,u[n=(a-a%64)/64*16+(a-a%4)/4]|=(a>t?128:r.charCodeAt(a))<<f,a++;return u[n=(a-a%64)/64*16+(a-a%4)/4]|=128<<a%4*8,u[e-2]=t<<3,u[e-1]=t>>>29,u}(r);for(g=1732584193,h=4023233417,d=2562383102,v=271733878,a=0;a<S.length;a+=16)i=g,C=h,c=d,g=t(g,h,d,v,S[a+0],7,3614090360),v=t(v,g,h,d,S[a+1],12,3905402710),d=t(d,v,g,h,S[a+2],17,606105819),h=t(h,d,v,g,S[a+3],22,3250441966),g=t(g,h,d,v,S[a+4],7,4118548399),v=t(v,g,h,d,S[a+5],12,1200080426),d=t(d,v,g,h,S[a+6],17,2821735955),h=t(h,d,v,g,S[a+7],22,4249261313),g=t(g,h,d,v,S[a+8],7,1770035416),v=t(v,g,h,d,S[a+9],12,2336552879),d=t(d,v,g,h,S[a+10],17,4294925233),h=t(h,d,v,g,S[a+11],22,2304563134),g=t(g,h,d,v,S[a+12],7,1804603682),v=t(v,g,h,d,S[a+13],12,4254626195),d=t(d,v,g,h,S[a+14],17,2792965006),h=t(h,d,v,g,S[a+15],22,1236535329),g=o(g,h,d,v,S[a+1],5,4129170786),v=o(v,g,h,d,S[a+6],9,3225465664),d=o(d,v,g,h,S[a+11],14,643717713),h=o(h,d,v,g,S[a+0],20,3921069994),g=o(g,h,d,v,S[a+5],5,3593408605),v=o(v,g,h,d,S[a+10],9,38016083),d=o(d,v,g,h,S[a+15],14,3634488961),h=o(h,d,v,g,S[a+4],20,3889429448),g=o(g,h,d,v,S[a+9],5,568446438),v=o(v,g,h,d,S[a+14],9,3275163606),d=o(d,v,g,h,S[a+3],14,4107603335),h=o(h,d,v,g,S[a+8],20,1163531501),g=o(g,h,d,v,S[a+13],5,2850285829),v=o(v,g,h,d,S[a+2],9,4243563512),d=o(d,v,g,h,S[a+7],14,1735328473),h=o(h,d,v,g,S[a+12],20,2368359562),g=e(g,h,d,v,S[a+5],4,4294588738),v=e(v,g,h,d,S[a+8],11,2272392833),d=e(d,v,g,h,S[a+11],16,1839030562),h=e(h,d,v,g,S[a+14],23,4259657740),g=e(g,h,d,v,S[a+1],4,2763975236),v=e(v,g,h,d,S[a+4],11,1272893353),d=e(d,v,g,h,S[a+7],16,4139469664),h=e(h,d,v,g,S[a+10],23,3200236656),g=e(g,h,d,v,S[a+13],4,681279174),v=e(v,g,h,d,S[a+0],11,3936430074),d=e(d,v,g,h,S[a+3],16,3572445317),h=e(h,d,v,g,S[a+6],23,76029189),g=e(g,h,d,v,S[a+9],4,3654602809),v=e(v,g,h,d,S[a+12],11,3873151461),d=e(d,v,g,h,S[a+15],16,530742520),h=e(h,d,v,g,S[a+2],23,3299628645),g=u(g,h,d,v,S[a+0],6,4096336452),v=u(v,g,h,d,S[a+7],10,1126891415),d=u(d,v,g,h,S[a+14],15,2878612391),h=u(h,d,v,g,S[a+5],21,4237533241),g=u(g,h,d,v,S[a+12],6,1700485571),v=u(v,g,h,d,S[a+3],10,2399980690),d=u(d,v,g,h,S[a+10],15,4293915773),h=u(h,d,v,g,S[a+1],21,2240044497),g=u(g,h,d,v,S[a+8],6,1873313359),v=u(v,g,h,d,S[a+15],10,4264355552),d=u(d,v,g,h,S[a+6],15,2734768916),h=u(h,d,v,g,S[a+13],21,1309151649),g=u(g,h,d,v,S[a+4],6,4149444226),v=u(v,g,h,d,S[a+11],10,3174756917),d=u(d,v,g,h,S[a+2],15,718787259),h=u(h,d,v,g,S[a+9],21,3951481745),g=n(g,i),h=n(h,C),d=n(d,c),v=n(v,S[a]);return(f(g)+f(h)+f(d)+f(v)).toLowerCase()}

  var APP_KEY = "24677475";
  var API = "https://acs-m.lazada.co.th/h5/";

  async function callApi(retry) {
    if (retry === undefined) retry = 0;
    var tkMatch = document.cookie.match(/_m_h5_tk=([^;]+)/);
    var token = tkMatch ? tkMatch[1].split("_")[0] : "";
    var t = Date.now().toString();
    var data = JSON.stringify({jumpUrl: jumpUrl});
    var sign = md5(token + "&" + t + "&" + APP_KEY + "&" + data);

    var qs = "jsv=2.6.1&appKey=" + APP_KEY + "&t=" + t + "&sign=" + sign
      + "&api=mtop.lazada.affiliate.lania.offer.getPromotionLinkFromJumpUrl"
      + "&v=1.1&type=originaljson&isSec=1&AntiCreep=true&timeout=5000"
      + "&needLogin=true&dataType=json&sessionOption=AutoLoginOnly"
      + "&x-i18n-language=en&x-i18n-regionID=TH"
      + "&data=" + encodeURIComponent(data);

    var url = API + "mtop.lazada.affiliate.lania.offer.getpromotionlinkfromjumpurl/1.1/?" + qs;
    var resp = await fetch(url, {credentials: "include"});
    var json = await resp.json();

    if (json.ret) {
      var ret = json.ret.join(",");
      if ((ret.indexOf("TOKEN_EMPTY") > -1 || ret.indexOf("TOKEN_EXOIRED") > -1 ||
           ret.indexOf("TOKEN_EXPIRED") > -1 || ret.indexOf("ILLEGAL_ACCESS") > -1) && retry < 3) {
        await new Promise(function(r) { setTimeout(r, 600); });
        return callApi(retry + 1);
      }
    }
    return json;
  }

  if (typeof lib !== "undefined" && lib.mtop) {
    try {
      return await new Promise(function(resolve, reject) {
        lib.mtop.request({
          api: "mtop.lazada.affiliate.lania.offer.getPromotionLinkFromJumpUrl",
          v: "1.1", isSec: true, AntiCreep: true, timeout: 10000,
          needLogin: true, dataType: "json", sessionOption: "AutoLoginOnly",
          getJSON: true, data: {jumpUrl: jumpUrl}
        }, resolve, reject);
      });
    } catch(e) {
      // lib.mtop failed, fallback to manual fetch
    }
  }

  return await callApi(0);
}
