import { getDocument, GlobalWorkerOptions } from './vendor/pdf.min.mjs';
GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs',import.meta.url).href;

export async function mountReader(data,host,signal,onPage) {
  const task = getDocument({data,isEvalSupported:false,enableScripting:false,enableXfa:false,useWasm:false});
  let pdf,renderTask,pageNumber=1,zoom=1,textMode=innerWidth<520,busy=false,redraw=false,resizeTimer,recordedPage=0;
  signal.addEventListener('abort',() => { renderTask?.cancel(); task.destroy(); },{once:true});
  try {
    pdf = await task.promise;
    if (signal.aborted) return;
    host.innerHTML = `<div class="reader-controls"><button class="btn secondary" data-pdf="prev" aria-label="Página anterior">←</button><span data-counter aria-live="polite"></span><button class="btn secondary" data-pdf="next" aria-label="Próxima página">→</button><span class="reader-spacer"></span><button class="btn secondary" data-pdf="less" aria-label="Diminuir zoom">−</button><button class="btn secondary" data-pdf="more" aria-label="Aumentar zoom">+</button><button class="btn secondary" data-pdf="mode"></button></div><div class="pdf-surface"><canvas aria-label="Página do PDF"></canvas><div class="pdf-text" tabindex="0" hidden></div></div><p class="hint" data-reader-status role="status"></p>`;
    const canvas=host.querySelector('canvas'); const text=host.querySelector('.pdf-text');
    async function draw() {
      if(signal.aborted)return;
      if(busy){redraw=true;return;}
      busy=true;
      for(const b of host.querySelectorAll('button')) b.disabled=true;
      try {
        host.querySelector('[data-counter]').textContent=`${pageNumber} / ${pdf.numPages}`;
        host.querySelector('[data-pdf="mode"]').textContent=textMode?'Ver PDF':'Modo texto';
        const page=await pdf.getPage(pageNumber);
        if(signal.aborted)return;
        canvas.hidden=textMode;text.hidden=!textMode;
        const extracted=await page.getTextContent();
        text.textContent=extracted.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('');
        if(!textMode) {
          const width=host.querySelector('.pdf-surface').clientWidth;
          const base=page.getViewport({scale:1});
          const viewport=page.getViewport({scale:width/base.width*zoom});
          const dpr=Math.min(devicePixelRatio||1,2);
          canvas.width=Math.floor(viewport.width*dpr);canvas.height=Math.floor(viewport.height*dpr);
          canvas.style.width=Math.floor(viewport.width)+'px';canvas.style.height=Math.floor(viewport.height)+'px';
          canvas.setAttribute('aria-label',`Página ${pageNumber} de ${pdf.numPages}. Use Modo texto para ler com leitor de tela.`);
          renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});
          await renderTask.promise;
        }
        host.querySelector('[data-reader-status]').textContent='';
        if(recordedPage!==pageNumber){recordedPage=pageNumber;onPage?.(pageNumber);}
      } catch(error) {
        if(!signal.aborted)host.querySelector('[data-reader-status]').textContent='Não foi possível mostrar esta página. Tente o Modo texto ou baixe o PDF.';
      } finally {
        busy=false;
        if(!signal.aborted){
          for(const b of host.querySelectorAll('button'))b.disabled=false;
          host.querySelector('[data-pdf="prev"]').disabled=pageNumber===1;
          host.querySelector('[data-pdf="next"]').disabled=pageNumber===pdf.numPages;
          host.querySelector('[data-pdf="less"]').disabled=textMode||zoom<=.75;
          host.querySelector('[data-pdf="more"]').disabled=textMode||zoom>=2;
          if(redraw){redraw=false;queueMicrotask(draw);}
        }
      }
    }
    host.addEventListener('click',event=>{
      const action=event.target.closest('[data-pdf]')?.dataset.pdf;
      if(!action||busy)return;
      if(action==='prev'&&pageNumber>1)pageNumber--;
      if(action==='next'&&pageNumber<pdf.numPages)pageNumber++;
      if(action==='less')zoom=Math.max(.75,zoom-.25);
      if(action==='more')zoom=Math.min(2,zoom+.25);
      if(action==='mode')textMode=!textMode;
      draw();
    });
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(draw,150);},{signal});
    signal.addEventListener('abort',()=>clearTimeout(resizeTimer),{once:true});
    await draw();
  } catch(error) {
    if(!signal.aborted)host.textContent='O leitor não conseguiu abrir este PDF. Use Baixar PDF para continuar.';
  }
}
