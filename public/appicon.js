/* Иконка приложения: ic_icon = soft | soft-dark | yellow | yellow-blue | classic */
(function(){
  var K=["soft","soft-dark","yellow","yellow-blue","classic"];
  function get(){ var v=null; try{ v=localStorage.getItem("ic_icon"); }catch(e){} return K.indexOf(v)>=0?v:"soft"; }
  function link(rel,href,type){
    var l=document.querySelector('link[rel="'+rel+'"]');
    if(!l){ l=document.createElement("link"); l.rel=rel; document.head.appendChild(l); }
    if(type) l.type=type; if(l.getAttribute("href")!==href) l.href=href;
  }
  function apply(k){
    k=k||get();
    if(k==="classic"){ link("icon","/icon.svg","image/svg+xml"); link("apple-touch-icon","/icon.svg"); }
    else { link("icon","/icons/"+k+".svg","image/svg+xml"); link("apple-touch-icon","/icons/"+k+"-180.png"); }
    link("manifest","/manifest-"+k+".json");
  }
  window.icIcon={get:get,list:K,apply:apply,set:function(k){ try{ localStorage.setItem("ic_icon",k); }catch(e){} apply(k); }};
  apply();
})();
