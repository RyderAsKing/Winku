(()=>{
// Winku's bridge, first in every visual (SPEC §3). It posts only: height, loaded, error, link,
// click and key (isBridgeMessage in app/ui/src/main/visuals.ts), and takes only Winku's theme.
const post=(m)=>parent.postMessage(Object.assign({winku:"visual"},m),"*");
addEventListener("error",(e)=>{if(e instanceof ErrorEvent){post({kind:"error",message:(e.message||"Script error")+(e.lineno?" (line "+e.lineno+")":"")});return}const t=e.target;if(t&&t!==window)post({kind:"error",message:"Couldn't load "+(t.src||t.href||t.tagName)})},true);
addEventListener("unhandledrejection",(e)=>post({kind:"error",message:"Unhandled rejection: "+String(e.reason&&e.reason.message||e.reason)}));
const root=document.documentElement;root.style.overflow="hidden";root.style.background="transparent";root.style.colorScheme="dark";
let last=-1;const measure=()=>{const b=document.body;const h=Math.ceil(Math.max(root.getBoundingClientRect().height,b?b.getBoundingClientRect().bottom+parseFloat(getComputedStyle(b).marginBottom||"0"):0));if(h!==last){last=h;post({kind:"height",height:h})}};
new ResizeObserver(measure).observe(root);
addEventListener("load",()=>{measure();post({kind:"loaded",height:last})});
// Links never navigate the frame: Winku opens http(s) ones in the browser.
addEventListener("click",(e)=>{const t=e.target instanceof Element?e.target:null;const a=t&&t.closest("a[href]");if(a){e.preventDefault();post({kind:"link",href:String(a.href).slice(0,4096)})}},true);
// A click on the visual itself, not on a control or something the page handled, opens it larger.
addEventListener("click",(e)=>{if(e.defaultPrevented||e.button!==0)return;const t=e.target instanceof Element?e.target:null;if(t&&t.closest("a,button,input,select,textarea,label,summary,details,[contenteditable],[role=button],[onclick],[tabindex]"))return;post({kind:"click"})});
// Winku's keys still work with focus in the frame: Esc and chords go to Winku; typing stays here.
addEventListener("keydown",(e)=>{if(e.key!=="Escape"&&!e.ctrlKey&&!e.altKey&&!e.metaKey)return;if(["Control","Alt","Shift","Meta"].includes(e.key))return;if(e.key==="Escape")e.preventDefault();post({kind:"key",key:String(e.key).slice(0,32),ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,meta:e.metaKey})},true);
// Winku's theme, from the frame's parent only, as CSS variables and nothing else.
addEventListener("message",(e)=>{if(e.source!==parent||e.source===window)return;const d=e.data;if(!d||d.winku!=="theme"||!d.vars||typeof d.vars!=="object")return;for(const k of Object.keys(d.vars)){const v=d.vars[k];if(/^--[a-z0-9-]{1,40}$/i.test(k)&&typeof v==="string"&&v.length<=200)root.style.setProperty(k,v)}});
})();
