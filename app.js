const STORAGE_KEY='groovekeeper-records-v1';
function loadRecords(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');
    if(!Array.isArray(saved))return [];
    const sixHours=6*60*60*1000;
    return saved.map(record=>{
      const normalized={...record,artist:titleCaseWords(record.artist),title:titleCaseWords(record.title)};
      return Date.now()-Number(record.discogsPriceFetchedAt||0)>sixHours?{...normalized,value:null,priceCurrency:'',discogsPrices:null}:normalized;
    });
  }catch{return []}
}
const records = loadRecords();
const grid = document.querySelector('#record-grid');
const empty = document.querySelector('#empty-state');
const search = document.querySelector('#search');
const sort = document.querySelector('#sort');
let activeFilter = 'all';
const serviceBase=()=>String(globalThis.RECORDSHELF_API_BASE||`http://${location.hostname||'127.0.0.1'}:8765`).replace(/\/$/,'');
let collectionSync=Promise.resolve();

function escapeHtml(value){return String(value??'').replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))}
function formatPrice(value,currency){if(value===null||value===''||!Number.isFinite(Number(value)))return '—';return `${escapeHtml(currency||'$')} ${Number(value).toFixed(2)}`}
function recordKey(artist,title){return `${artist||''}|${title||''}`.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9|]+/g,' ').trim()}
function getDuplicateGroups(){
  const grouped=new Map();
  records.forEach(record=>{const key=recordKey(record.artist,record.title);if(key==='|')return;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(record)});
  return [...grouped.entries()].filter(([,copies])=>copies.length>1).map(([key,copies])=>({key,copies}));
}
function refreshDuplicateFlags(){const duplicateIds=new Set(getDuplicateGroups().flatMap(group=>group.copies.map(record=>String(record.id))));records.forEach(record=>record.flag=duplicateIds.has(String(record.id)))}
function saveRecords(){
  refreshDuplicateFlags();localStorage.setItem(STORAGE_KEY,JSON.stringify(records));
  const snapshot=JSON.parse(JSON.stringify(records));
  collectionSync=collectionSync.catch(()=>{}).then(()=>fetch(`${serviceBase()}/collection/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:snapshot}),signal:AbortSignal.timeout(20000)})).catch(error=>console.warn('Collection sync failed',error));
}
async function hydrateCollection(){
  try{
    const response=await fetch(`${serviceBase()}/collection`,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`Collection returned ${response.status}`);const serverRecords=(await response.json()).records||[];
    if(serverRecords.length){records.splice(0,records.length,...serverRecords);localStorage.setItem(STORAGE_KEY,JSON.stringify(records));render()}
    else if(records.length)saveRecords();
  }catch(error){console.warn('Using browser collection until SQLite is available',error)}
}
function updateCollectionCounts(){
  const total=records.length;
  const duplicateGroups=getDuplicateGroups();
  const duplicateCount=duplicateGroups.reduce((count,group)=>count+group.copies.length-1,0);
  const duplicateRecordCount=duplicateGroups.reduce((count,group)=>count+group.copies.length,0);
  const collectionNav=document.querySelector('.nav-item[data-view="collection"] .nav-count');
  if(collectionNav)collectionNav.textContent=total;
  const duplicateNav=document.querySelector('.nav-item[data-view="duplicates"] .nav-count');
  if(duplicateNav)duplicateNav.textContent=duplicateGroups.length;
  const collectionHeading=document.querySelector('#collection-panel .heading-count');
  if(collectionHeading)collectionHeading.textContent=total;
  const allFilter=document.querySelector('.filter-chip[data-filter="all"] span');
  if(allFilter)allFilter.textContent=total;
  const duplicateFilter=document.querySelector('.filter-chip[data-filter="duplicates"] span');
  if(duplicateFilter)duplicateFilter.textContent=duplicateRecordCount;
  const totalStat=document.querySelector('.stats-grid .stat-card .stat-value');
  if(totalStat)totalStat.textContent=total;
  const priced=records.filter(record=>record.value!==null&&record.value!==''&&Number.isFinite(Number(record.value)));
  const valueStat=document.querySelectorAll('.stats-grid .stat-card .stat-value')[1];
  if(valueStat){const currencies=[...new Set(priced.map(record=>record.priceCurrency||'$'))];valueStat.textContent=priced.length&&currencies.length===1?`${currencies[0]} ${priced.reduce((sum,record)=>sum+Number(record.value),0).toFixed(0)}`:'$0'}
  const duplicateStat=document.querySelectorAll('.stats-grid .stat-card .stat-value')[2];
  if(duplicateStat)duplicateStat.innerHTML=`${duplicateCount} <small>${duplicateCount===1?'extra':'extras'}</small>`;
  const duplicateNote=document.querySelector('.stats-grid .stat-card.warm .stat-note');
  if(duplicateNote)duplicateNote.textContent=duplicateCount?`${duplicateGroups.length} group${duplicateGroups.length===1?'':'s'} needs checking`:'No duplicates yet';
}

function render(){
  refreshDuplicateFlags();
  const query = search.value.toLowerCase().trim();
  let result = records.filter(r => `${r.artist} ${r.title} ${r.meta}`.toLowerCase().includes(query));
  if(activeFilter==='near-mint') result=result.filter(r=>r.condition==='Near mint');
  if(activeFilter==='jazz') result=result.filter(r=>['Miles Davis'].includes(r.artist));
  if(activeFilter==='duplicates') result=result.filter(r=>r.flag);
  if(sort.value==='artist') result.sort((a,b)=>a.artist.localeCompare(b.artist));
  if(sort.value==='value') result.sort((a,b)=>b.value-a.value);
  if(sort.value==='year') result.sort((a,b)=>b.year-a.year);
  if(sort.value==='recent') result.sort((a,b)=>Number(b.recent)-Number(a.recent));
  grid.innerHTML=result.map(r=>`<article class="record-card"><div class="cover ${escapeHtml(r.cover||'cover-1')} ${r.coverUrl?'has-artwork':''}">${r.coverUrl?`<img class="cover-art" src="${escapeHtml(r.coverUrl)}" alt="Cover of ${escapeHtml(r.title)}" loading="lazy" onerror="this.closest('.cover').classList.remove('has-artwork');this.remove()">`:''}${r.flag?'<span class="flag">⌘ Check pressing</span>':''}<div class="cover-title">${escapeHtml(r.title)}<span class="cover-sub">${escapeHtml(r.artist)}</span>${r.artworkStatus==='queued'?'<small class="artwork-note">Finding artwork…</small>':''}</div></div><div class="record-info"><h3 class="record-title">${escapeHtml(r.title)}</h3><div class="record-artist">${escapeHtml(r.artist||'Unknown artist')} · ${escapeHtml(r.year||'—')}</div><div class="pressing-line">${r.discogsReleaseId?`${escapeHtml(r.country||'Unknown country')} · ${escapeHtml(r.label||'Unknown label')} · ${escapeHtml(r.catno||'No cat. no.')}`:'Pressing not confirmed'}</div><div class="record-footer"><div><div class="record-condition">● ${escapeHtml(r.condition||'Not graded')}</div><div class="record-year">${escapeHtml(r.meta||'Vinyl')}</div></div><div class="record-price">${formatPrice(r.value,r.priceCurrency)}</div></div><div class="record-actions"><div><button class="pressing-button" type="button" data-record-id="${escapeHtml(r.id)}">${r.discogsReleaseId?'Change pressing':'Find pressing'}</button><button class="edit-record-button" type="button" data-edit-id="${escapeHtml(r.id)}">Edit</button></div>${r.discogsUrl?`<a href="${escapeHtml(r.discogsUrl)}" target="_blank" rel="noopener">Data provided by Discogs</a>`:''}</div></div></article>`).join('');
  empty.hidden=result.length!==0;
  updateCollectionCounts();
}
search.addEventListener('input',render); sort.addEventListener('change',render);
document.querySelectorAll('.filter-chip').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.filter-chip').forEach(b=>b.classList.remove('active'));btn.classList.add('active');activeFilter=btn.dataset.filter;render()}));
document.querySelectorAll('.segment').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.segment').forEach(b=>b.classList.remove('active'));btn.classList.add('active');grid.classList.toggle('list-layout',btn.dataset.layout==='list')}));
document.querySelector('#filter-button').addEventListener('click',()=>document.querySelector('#filter-row').classList.toggle('hidden'));
const collectionPanel=document.querySelector('#collection-panel'); const identifyPanel=document.querySelector('#identify-panel'); const scanPanel=document.querySelector('#scan-panel'); const duplicatePanel=document.querySelector('#duplicate-panel');
document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  const view=btn.dataset.view;
  identifyPanel.hidden=view!=='identify';scanPanel.hidden=view!=='scan';duplicatePanel.hidden=view!=='duplicates';collectionPanel.hidden=['identify','scan','duplicates'].includes(view);
  if(view==='scan')document.querySelector('.page-heading').scrollIntoView({behavior:'smooth',block:'start'});
  else if(view==='identify')identifyPanel.scrollIntoView({behavior:'smooth',block:'start'});
  else if(view==='duplicates'){renderDuplicateGroups();duplicatePanel.scrollIntoView({behavior:'smooth',block:'start'})}
  else{activeFilter='all';document.querySelectorAll('.filter-chip').forEach(b=>b.classList.toggle('active',b.dataset.filter==='all'));render()}
}));
function showCollection(){document.querySelectorAll('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view==='collection'));identifyPanel.hidden=true;scanPanel.hidden=true;duplicatePanel.hidden=true;collectionPanel.hidden=false;activeFilter='all';document.querySelectorAll('.filter-chip').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));render();collectionPanel.scrollIntoView({behavior:'smooth',block:'start'})}
function showIdentify(){document.querySelectorAll('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view==='identify'));collectionPanel.hidden=true;scanPanel.hidden=true;duplicatePanel.hidden=true;identifyPanel.hidden=false;identifyPanel.scrollIntoView({behavior:'smooth',block:'start'})}
document.querySelector('#open-identify').addEventListener('click',showIdentify);

const coverInput=document.querySelector('#cover-input');const barcodeInput=document.querySelector('#barcode-input');const identifyProgress=document.querySelector('#identify-progress');const identifyPreview=document.querySelector('#identify-preview');const identifyResults=document.querySelector('#identify-results');const identifyReleaseList=document.querySelector('#identify-release-list');let identifyPreviewUrl='';let identifiedReleases=[];
document.querySelectorAll('.identify-method').forEach(button=>button.addEventListener('click',()=>{
  const mode=button.dataset.identifyMode;document.querySelectorAll('.identify-method').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-selected',String(item===button))});document.querySelectorAll('[data-identify-workspace]').forEach(workspace=>workspace.hidden=workspace.dataset.identifyWorkspace!==mode);identifyProgress.hidden=true;
}));
document.querySelector('#choose-cover').addEventListener('click',()=>coverInput.click());document.querySelector('#choose-barcode').addEventListener('click',()=>barcodeInput.click());coverInput.addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';if(file)identifyCover(file)});barcodeInput.addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';if(file)identifyBarcodePhoto(file)});document.querySelector('#lookup-barcode').addEventListener('click',()=>lookupBarcode(document.querySelector('#barcode-number').value));
function setIdentifyProgress(message,type=''){identifyProgress.hidden=false;identifyProgress.className=`identify-progress ${type}`;identifyProgress.textContent=message}
function showIdentifyPreview(file,label){if(identifyPreviewUrl)URL.revokeObjectURL(identifyPreviewUrl);identifyPreviewUrl=URL.createObjectURL(file);identifyPreview.hidden=false;identifyPreview.innerHTML=`<img src="${identifyPreviewUrl}" alt="${escapeHtml(label)}"><span>${escapeHtml(label)}</span>`}
function resetIdentify(){if(identifyPreviewUrl)URL.revokeObjectURL(identifyPreviewUrl);identifyPreviewUrl='';identifiedReleases=[];coverInput.value='';barcodeInput.value='';document.querySelector('#barcode-number').value='';identifyPreview.hidden=true;identifyPreview.innerHTML='';identifyProgress.hidden=true;identifyResults.hidden=true;identifyReleaseList.innerHTML=''}
document.querySelector('#identify-reset').addEventListener('click',resetIdentify);
async function prepareIdentificationImage(file){const image=await loadImage(file);const canvas=document.createElement('canvas');const scale=Math.min(1,1024/Math.max(image.width,image.height));canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);const context=canvas.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.86)}
async function fetchDiscogsReleases(params){const response=await fetch(`${serviceBase()}/discogs/search?${new URLSearchParams(params)}`,{signal:AbortSignal.timeout(25000)});const result=await response.json();if(!response.ok)throw new Error(result.setupRequired?'Discogs needs a token in the local .env file.':result.error||`Discogs returned ${response.status}`);return result.releases||[]}
function splitDiscogsTitle(value){const parts=String(value||'').split(/\s+-\s+/);return parts.length>1?{artist:parts.shift(),title:parts.join(' - ')}:{artist:'',title:value||''}}
function renderIdentifiedReleases(releases,summary){identifiedReleases=releases;identifyResults.hidden=false;document.querySelector('#identify-result-count').textContent=releases.length;document.querySelector('#identify-summary').textContent=summary;identifyReleaseList.innerHTML=releases.length?releases.map((release,index)=>{const names=splitDiscogsTitle(release.title);const duplicate=records.some(record=>String(record.discogsReleaseId||'')===String(release.id)||recordKey(record.artist,record.title)===recordKey(names.artist,names.title));return `<label class="identify-release ${duplicate?'possible-existing':''}"><input type="radio" name="identified-release" value="${release.id}" ${index===0?'checked':''}><span class="identify-release-cover">${release.coverUrl?`<img src="${escapeHtml(release.coverUrl)}" alt="" loading="lazy">`:'◎'}</span><span class="identify-release-info"><strong>${escapeHtml(release.title)}</strong><span>${escapeHtml(release.year||'Unknown year')} · ${escapeHtml(release.country||'Unknown country')}</span><small>${escapeHtml(release.label||'Unknown label')} · ${escapeHtml(release.catno||'No catalogue number')} · ${escapeHtml((release.format||[]).join(' · ')||'Vinyl')}</small>${duplicate?'<b>Already in your collection</b>':''}</span><span class="identify-keep">Choose</span></label>`}).join(''):'<div class="no-results">No vinyl pressings matched. Try the other identification method or enter the record manually.</div>';setIdentifyProgress(releases.length?`Found ${releases.length} possible vinyl pressing${releases.length===1?'':'s'}.`:'No matching vinyl pressing found.',releases.length?'success':'error');identifyResults.scrollIntoView({behavior:'smooth',block:'start'})}
async function identifyCover(file){showIdentifyPreview(file,'Front cover photo');identifyResults.hidden=true;setIdentifyProgress('Reading the front cover with the local vision model…');try{const image=await prepareIdentificationImage(file);const prompt='This is the FRONT COVER of one vinyl record. Identify the most likely artist and album title using visible lettering and, when distinctive, the cover artwork. Return ONLY a valid JSON array with one object: [{"artist":"...","title":"...","confidence":0.0,"evidence":"visible words or short visual reason"}]. Use an empty string when unknown. Lower confidence when relying on artwork, and return [] rather than inventing a record when uncertain.';const response=await fetch(`${serviceBase()}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,prompt}),signal:AbortSignal.timeout(240000)});if(!response.ok)throw new Error((await response.json()).error||`Vision returned ${response.status}`);const result=await response.json();const read=(result.records||[])[0];if(!read||(!read.artist&&!read.title))throw new Error('The cover was not clear or distinctive enough to identify.');setIdentifyProgress(`Identified “${[read.artist,read.title].filter(Boolean).join(' — ')}”. Searching Discogs…`);const releases=await fetchDiscogsReleases({artist:read.artist||'',title:read.title||''});renderIdentifiedReleases(releases,`Local vision suggests ${titleCaseWords(read.artist)||'an unknown artist'} — ${titleCaseWords(read.title)||'an unknown title'} (${Math.round((Number(read.confidence)||0)*100)}% confidence). Confirm the pressing details below.`)}catch(error){setIdentifyProgress(`Cover identification failed: ${error.name==='TimeoutError'?'the local model timed out':error.message}`,'error')}}
async function decodeBarcode(file){
  const image=await loadImage(file);
  if('BarcodeDetector' in window){try{const detector=new BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e']});const detected=await detector.detect(image);if(detected[0]?.rawValue)return detected[0].rawValue}catch{}}
  if(window.ZXingBrowser?.BrowserMultiFormatReader){const reader=new ZXingBrowser.BrowserMultiFormatReader();const result=await reader.decodeFromImageElement(image);return result?.getText?.()||result?.text||String(result||'')}
  throw new Error('No barcode was detected. Try a closer photo or enter the printed number below.')
}
async function identifyBarcodePhoto(file){showIdentifyPreview(file,'Barcode photo');identifyResults.hidden=true;setIdentifyProgress('Reading the barcode locally…');try{const barcode=String(await decodeBarcode(file)).replace(/\D/g,'');if(!barcode)throw new Error('No barcode number was detected.');document.querySelector('#barcode-number').value=barcode;await lookupBarcode(barcode)}catch(error){setIdentifyProgress(error.message,'error')}}
async function lookupBarcode(rawBarcode){const barcode=String(rawBarcode||'').replace(/\D/g,'');if(barcode.length<8){setIdentifyProgress('Enter at least 8 barcode digits.','error');return}identifyResults.hidden=true;setIdentifyProgress(`Searching Discogs for barcode ${barcode}…`);try{const releases=await fetchDiscogsReleases({barcode});renderIdentifiedReleases(releases,`Barcode ${barcode} can appear on more than one pressing. Compare the country, label and catalogue number before adding.`)}catch(error){setIdentifyProgress(`Barcode lookup failed: ${error.name==='TimeoutError'?'Discogs timed out':error.message}`,'error')}}
document.querySelector('#add-identified').addEventListener('click',()=>{const releaseId=document.querySelector('[name="identified-release"]:checked')?.value;const release=identifiedReleases.find(item=>String(item.id)===releaseId);if(!release)return;const names=splitDiscogsTitle(release.title);const record=createCollectionRecord(names.artist,names.title,collectionDataFromRelease(release));records.push(record);saveRecords();showCollection();queueArtwork(record);queueDiscogsPrice(record);toast.innerHTML='Identified record added to your collection <span>✓</span>';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)});

function duplicateRecordScore(record){return ['discogsReleaseId','coverUrl','catno','label','country','value'].reduce((score,key)=>score+(record[key]?1:0),0)+Number(record.recent||0)/1e15}
function renderDuplicateGroups(){
  const groups=getDuplicateGroups();
  document.querySelector('#duplicate-group-count').textContent=groups.length;
  const container=document.querySelector('#duplicate-groups');
  container.innerHTML=groups.length?groups.map((group,groupIndex)=>{
    const preferred=[...group.copies].sort((a,b)=>duplicateRecordScore(b)-duplicateRecordScore(a))[0];
    return `<article class="duplicate-group" data-duplicate-group="${groupIndex}"><div class="duplicate-group-header"><div><strong>${escapeHtml(group.copies[0].title||'Untitled record')}</strong><span>${escapeHtml(group.copies[0].artist||'Unknown artist')} · ${group.copies.length} copies</span></div><span>Keep one</span></div><div class="duplicate-copies">${group.copies.map(record=>`<label class="duplicate-copy"><input type="radio" name="keep-${groupIndex}" value="${escapeHtml(record.id)}" ${record===preferred?'checked':''}><span class="duplicate-cover ${escapeHtml(record.cover||'cover-1')} ${record.coverUrl?'has-artwork':''}">${record.coverUrl?`<img src="${escapeHtml(record.coverUrl)}" alt="" loading="lazy">`:''}</span><span class="duplicate-copy-info"><strong>${escapeHtml(record.title)}</strong><span>${escapeHtml(record.artist||'Unknown artist')} · ${escapeHtml(record.year||'Unknown year')}</span><small>${record.discogsReleaseId?`${escapeHtml(record.country||'Unknown country')} · ${escapeHtml(record.label||'Unknown label')} · ${escapeHtml(record.catno||'No cat. no.')}`:'Pressing not confirmed'} · Added ${new Date(Number(record.recent)||Date.now()).toLocaleDateString()}</small></span><span class="keep-label">Keep</span></label>`).join('')}</div><button class="remove-duplicates" type="button">Remove ${group.copies.length-1} other ${group.copies.length===2?'copy':'copies'}</button></article>`;
  }).join(''):'<div class="duplicate-empty"><span>✓</span><h3>No possible duplicates</h3><p>Your collection currently has one copy of each artist and album combination.</p></div>';
}
document.querySelector('#duplicate-groups').addEventListener('click',event=>{
  const button=event.target.closest('.remove-duplicates');if(!button)return;
  const article=button.closest('[data-duplicate-group]');const group=getDuplicateGroups()[Number(article.dataset.duplicateGroup)];if(!group)return;
  const keepId=article.querySelector('input[type="radio"]:checked')?.value;const keep=group.copies.find(record=>String(record.id)===keepId);if(!keep)return;
  const remove=group.copies.filter(record=>record!==keep);
  if(!confirm(`Keep “${keep.title}” and permanently remove ${remove.length} other ${remove.length===1?'copy':'copies'} from this browser?`))return;
  const removeIds=new Set(remove.map(record=>String(record.id)));for(let index=records.length-1;index>=0;index--)if(removeIds.has(String(records[index].id)))records.splice(index,1);
  saveRecords();render();renderDuplicateGroups();toast.innerHTML=`Removed ${remove.length} duplicate ${remove.length===1?'copy':'copies'} <span>✓</span>`;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800);
});

let artworkQueue=Promise.resolve();
function jsonpAlbumSearch(artist,title){
  return new Promise((resolve,reject)=>{
    const callback=`groovekeeperArtwork_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script=document.createElement('script');
    const timeout=setTimeout(()=>finish(new Error('Artwork search timed out')),12000);
    function finish(error,value){clearTimeout(timeout);delete window[callback];script.remove();error?reject(error):resolve(value)}
    window[callback]=payload=>finish(null,payload);
    script.onerror=()=>finish(new Error('Artwork search failed'));
    const params=new URLSearchParams({term:`${artist} ${title}`.trim(),country:'AU',media:'music',entity:'album',limit:'5',callback});
    script.src=`https://itunes.apple.com/search?${params}`;
    document.head.appendChild(script);
  });
}
function artworkMatchScore(result,artist,title){
  const clean=value=>(value||'').toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();
  const wantedArtist=clean(artist);const wantedTitle=clean(title);const foundArtist=clean(result.artistName);const foundTitle=clean(result.collectionName);
  return (wantedArtist&&foundArtist===wantedArtist?8:wantedArtist&&foundArtist.includes(wantedArtist)?3:0)+(wantedTitle&&foundTitle===wantedTitle?10:wantedTitle&&(foundTitle.includes(wantedTitle)||wantedTitle.includes(foundTitle))?5:0);
}
async function findAlbumArtwork(record){
  const payload=await jsonpAlbumSearch(record.artist,record.title);
  const matches=(payload.results||[]).filter(result=>result.artworkUrl100).sort((a,b)=>artworkMatchScore(b,record.artist,record.title)-artworkMatchScore(a,record.artist,record.title));
  const match=matches[0];
  if(!match)return null;
  return {coverUrl:match.artworkUrl100.replace(/\/\d+x\d+bb(?:-\d+)?\./,'/600x600bb.'),year:(match.releaseDate||'').slice(0,4),sourceUrl:match.collectionViewUrl};
}
function queueArtwork(record){
  if(record.coverUrl||record.artworkStatus==='queued'||(!record.artist&&!record.title))return;
  record.artworkStatus='queued';saveRecords();render();
  artworkQueue=artworkQueue.then(async()=>{
    try{const artwork=await findAlbumArtwork(record);if(artwork){Object.assign(record,artwork);record.artworkStatus='found'}else record.artworkStatus='unavailable'}catch{record.artworkStatus='unavailable'}
    saveRecords();render();
    await new Promise(resolve=>setTimeout(resolve,3100));
  });
}
function createCollectionRecord(artist,title,extra={}){
  const key=recordKey(artist,title);
  const existingDuplicates=records.filter(record=>recordKey(record.artist,record.title)===key);
  existingDuplicates.forEach(record=>record.flag=true);
  const duplicate=existingDuplicates.length>0;
  return {id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,artist:titleCaseWords(artist),title:titleCaseWords(title),year:'—',condition:'Not graded',meta:'Vinyl · pressing not confirmed',value:null,recent:Date.now(),cover:`cover-${(records.length%6)+1}`,flag:duplicate,artworkStatus:'',...extra};
}
function collectionDataFromRelease(release){return {discogsReleaseId:release.id,discogsUrl:release.discogsUrl,year:release.year||'—',country:release.country,label:release.label,catno:release.catno,format:release.format,meta:`Vinyl · ${(release.format||[]).join(' · ')||'format unlisted'}`,coverUrl:release.coverUrl||'',artworkStatus:release.coverUrl?'found':''}}

const pressingBackdrop=document.querySelector('#pressing-backdrop');
const pressingStatus=document.querySelector('#pressing-status');
const pressingResults=document.querySelector('#pressing-results');
let activePressingRecord=null;
let pressingCandidates=[];
function closePressingModal(){pressingBackdrop.hidden=true;activePressingRecord=null;pressingCandidates=[]}
document.querySelector('#close-pressing').addEventListener('click',closePressingModal);
pressingBackdrop.addEventListener('click',event=>{if(event.target===pressingBackdrop)closePressingModal()});
function renderPressingCandidates(releases){
  pressingResults.innerHTML=releases.length?releases.map(release=>`<article class="pressing-option"><div><strong>${escapeHtml(release.title)}</strong><span>${escapeHtml(release.year||'Unknown year')} · ${escapeHtml(release.country||'Unknown country')}</span><span>${escapeHtml(release.label||'Unknown label')} · ${escapeHtml(release.catno||'No catalogue number')}</span><span>${escapeHtml((release.format||[]).join(' · ')||'Vinyl')}</span></div><button type="button" data-release-id="${release.id}">This is my copy</button><a href="${escapeHtml(release.discogsUrl)}" target="_blank" rel="noopener">View on Discogs</a></article>`).join(''):'<div class="no-results">No vinyl releases matched this artist and title. Check the spelling or add the pressing later.</div>';
}
async function openPressingSearch(record){
  activePressingRecord=record;
  pressingBackdrop.hidden=false;
  document.querySelector('#pressing-modal-title').textContent=`Find ${record.title}`;
  document.querySelector('#pressing-intro').textContent=`Compare ${record.artist||'the artist'} pressings using the country, label and catalogue number printed on your copy.`;
  pressingStatus.className='pressing-status';pressingStatus.textContent='Searching Discogs for vinyl releases…';pressingResults.innerHTML='';
  try{
    const params=new URLSearchParams({artist:record.artist||'',title:record.title||''});
    const response=await fetch(`${serviceBase()}/discogs/search?${params}`,{signal:AbortSignal.timeout(25000)});
    const result=await response.json();
    if(!response.ok){
      if(result.setupRequired){pressingStatus.className='pressing-status setup';pressingStatus.innerHTML='Discogs needs a personal access token. <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Create one in Discogs</a>, copy <code>.env.example</code> to <code>.env</code>, add the token, then restart <code>npm run start</code>.';return}
      throw new Error(result.error||`Search returned ${response.status}`);
    }
    if(!Array.isArray(result.releases))throw new Error('Restart npm run start to load the Discogs service update');
    pressingCandidates=result.releases;
    pressingStatus.className='pressing-status success';pressingStatus.textContent=`Found ${pressingCandidates.length} possible vinyl pressing${pressingCandidates.length===1?'':'s'}.`;
    renderPressingCandidates(pressingCandidates);
  }catch(error){pressingStatus.className='pressing-status error';pressingStatus.textContent=`Pressing search failed: ${error.name==='TimeoutError'?'the local service timed out':error.message}`}
}
grid.addEventListener('click',event=>{const button=event.target.closest('.pressing-button');if(!button)return;const record=records.find(item=>String(item.id)===button.dataset.recordId);if(record)openPressingSearch(record)});
const editBackdrop=document.querySelector('#edit-backdrop');const editForm=document.querySelector('#edit-form');
grid.addEventListener('click',event=>{const button=event.target.closest('[data-edit-id]');if(!button)return;const record=records.find(item=>String(item.id)===button.dataset.editId);if(!record)return;editForm.elements.id.value=record.id;editForm.elements.artist.value=record.artist||'';editForm.elements.title.value=record.title||'';editForm.elements.year.value=record.year||'';editForm.elements.condition.value=record.condition||'Not graded';editForm.elements.meta.value=record.meta||'';editBackdrop.hidden=false});
function closeEdit(){editBackdrop.hidden=true;editForm.reset()}
document.querySelector('#close-edit').addEventListener('click',closeEdit);editBackdrop.addEventListener('click',event=>{if(event.target===editBackdrop)closeEdit()});
editForm.addEventListener('submit',event=>{event.preventDefault();const record=records.find(item=>String(item.id)===editForm.elements.id.value);if(!record)return;Object.assign(record,{artist:titleCaseWords(editForm.elements.artist.value),title:titleCaseWords(editForm.elements.title.value),year:editForm.elements.year.value.trim()||'—',condition:editForm.elements.condition.value,meta:editForm.elements.meta.value.trim()||'Vinyl'});saveRecords();render();closeEdit();toast.innerHTML='Record updated <span>✓</span>';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2200)});
document.querySelector('#delete-record').addEventListener('click',()=>{const index=records.findIndex(item=>String(item.id)===editForm.elements.id.value);if(index<0)return;const record=records[index];if(!confirm(`Delete “${record.title}” by ${record.artist||'Unknown artist'} from your collection?`))return;records.splice(index,1);saveRecords();render();closeEdit();toast.innerHTML='Record deleted <span>✓</span>';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2200)});

function downloadCollection(filename,type,contents){const url=URL.createObjectURL(new Blob([contents],{type}));const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function csvCell(value){return `"${String(value??'').replace(/"/g,'""')}"`}
document.querySelector('#export-json').addEventListener('click',()=>downloadCollection(`groovekeeper-${new Date().toISOString().slice(0,10)}.json`,'application/json',JSON.stringify({exportedAt:new Date().toISOString(),records},null,2)));
document.querySelector('#export-csv').addEventListener('click',()=>{const columns=['Artist','Title','Year','Condition','Label','Catalog Number','Discogs Release ID','Estimated Value','Currency','Notes'];const rows=records.map(record=>[record.artist,record.title,record.year,record.condition,record.label,record.catno,record.discogsReleaseId,record.value,record.priceCurrency,record.meta].map(csvCell).join(','));downloadCollection(`groovekeeper-${new Date().toISOString().slice(0,10)}.csv`,'text/csv;charset=utf-8',[columns.map(csvCell).join(','),...rows].join('\n'))});
const discogsImport=document.querySelector('#discogs-import');document.querySelector('#import-discogs').addEventListener('click',()=>discogsImport.click());discogsImport.addEventListener('change',async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{const response=await fetch(`${serviceBase()}/collection/import-discogs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv:await file.text()}),signal:AbortSignal.timeout(20000)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Import failed');records.push(...(result.records||[]));saveRecords();render();toast.innerHTML=`Imported ${result.count} Discogs record${result.count===1?'':'s'} <span>✓</span>`;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)}catch(error){toast.textContent=`Import failed: ${error.message}`;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),3500)}});
const buyCheckSearch=document.querySelector('#buy-check-search');const buyCheckResult=document.querySelector('#buy-check-result');buyCheckSearch.addEventListener('input',()=>{const query=buyCheckSearch.value.toLowerCase().trim();if(query.length<2){buyCheckResult.textContent='Type a record name to check your collection.';buyCheckResult.className='';return}const matches=records.filter(record=>`${record.artist} ${record.title} ${record.catno||''}`.toLowerCase().includes(query)).slice(0,4);buyCheckResult.className=matches.length?'owned':'clear';buyCheckResult.innerHTML=matches.length?`<strong>You own ${matches.length} matching ${matches.length===1?'record':'records'}.</strong>${matches.map(record=>`<span>${escapeHtml(record.artist)} — ${escapeHtml(record.title)}${record.catno?` · ${escapeHtml(record.catno)}`:''}</span>`).join('')}`:'<strong>No match in your collection.</strong><span>Check the spelling or identify it by cover/barcode.</span>'});
function priceForCondition(prices,condition){
  const keys={'Near mint':'Near Mint (NM or M-)','Very good plus':'Very Good Plus (VG+)','Very good':'Very Good (VG)','Good':'Good (G)'};
  return prices[keys[condition]]||prices['Very Good Plus (VG+)']||Object.values(prices)[0]||null;
}
let discogsPriceQueue=Promise.resolve();
function queueDiscogsPrice(record){
  if(!record.discogsReleaseId||record.discogsPriceRefreshQueued)return;
  const sixHours=6*60*60*1000;
  if(record.discogsPriceFetchedAt&&Date.now()-record.discogsPriceFetchedAt<sixHours)return;
  record.discogsPriceRefreshQueued=true;
  discogsPriceQueue=discogsPriceQueue.then(async()=>{
    try{
      const response=await fetch(`${serviceBase()}/discogs/price/${record.discogsReleaseId}`,{signal:AbortSignal.timeout(25000)});
      if(response.ok){const result=await response.json();if(result.prices){record.discogsPrices=result.prices;const price=priceForCondition(result.prices,record.condition);record.value=price?.value??null;record.priceCurrency=price?.currency||'';record.discogsPriceFetchedAt=Date.now()}}
    }catch{}
    delete record.discogsPriceRefreshQueued;saveRecords();render();
  });
}
pressingResults.addEventListener('click',async event=>{
  const button=event.target.closest('[data-release-id]');if(!button||!activePressingRecord)return;
  const release=pressingCandidates.find(item=>String(item.id)===button.dataset.releaseId);if(!release)return;
  button.disabled=true;button.textContent='Saving pressing…';
  let price=null;
  try{
    const response=await fetch(`${serviceBase()}/discogs/price/${release.id}`,{signal:AbortSignal.timeout(25000)});
    if(response.ok){const result=await response.json();activePressingRecord.discogsPrices=result.prices;price=priceForCondition(result.prices,activePressingRecord.condition)}
  }catch{}
  records.filter(record=>record!==activePressingRecord&&String(record.discogsReleaseId)===String(release.id)).forEach(record=>{record.flag=true;activePressingRecord.flag=true});
  Object.assign(activePressingRecord,{discogsReleaseId:release.id,discogsUrl:release.discogsUrl,year:release.year||activePressingRecord.year,country:release.country,label:release.label,catno:release.catno,format:release.format,meta:`Vinyl · ${(release.format||[]).join(' · ')||'format unlisted'}`,value:price?.value??null,priceCurrency:price?.currency||'',discogsPriceFetchedAt:price?Date.now():null});
  saveRecords();render();closePressingModal();toast.innerHTML='Pressing confirmed <span>✓</span>';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)
});
const backdrop=document.querySelector('#modal-backdrop'); const toast=document.querySelector('#toast');
document.querySelector('#open-add').addEventListener('click',()=>{backdrop.hidden=false;document.querySelector('[name=artist]').focus()});
document.querySelector('#close-modal').addEventListener('click',()=>backdrop.hidden=true); backdrop.addEventListener('click',e=>{if(e.target===backdrop)backdrop.hidden=true});
document.querySelector('#lookup-button').addEventListener('click',()=>{const artist=document.querySelector('[name=artist]').value||'your artist';const title=document.querySelector('[name=title]').value||'this release';const out=document.querySelector('#lookup-result');out.hidden=false;out.innerHTML=`<strong>Possible match found</strong><br>${artist} — ${title}, original release. Exact pressing data will connect here when a Discogs API key is configured.`});
document.querySelector('#add-form').addEventListener('submit',e=>{e.preventDefault();const artist=e.target.querySelector('[name=artist]').value;const title=e.target.querySelector('[name=title]').value;const condition=e.target.querySelector('[name=condition]').value;const record=createCollectionRecord(artist,title,{condition});records.push(record);saveRecords();backdrop.hidden=true;e.target.reset();showCollection();queueArtwork(record);toast.innerHTML='Record added to your collection <span>✓</span>';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)});

// Spine scan flow. The local OCR fallback runs in the browser with Tesseract.js;
// the optional Mistral provider sends only prepared crops to Mistral's OCR API.
const spineInput=document.querySelector('#spine-input'); const dropzone=document.querySelector('#dropzone'); const photoQueue=document.querySelector('#photo-queue'); const photoStrip=document.querySelector('#photo-strip'); const autoScan=document.querySelector('#auto-scan'); const detectedCrops=document.querySelector('#detected-crops'); const scanResults=document.querySelector('#scan-results'); const scanFiles=[]; const cropData=[]; let bulkScanRunning=false;let activeScanSessionId='';let activeScanNextPanel=0;let activeScanRecords=[];
async function saveScanCheckpoint(status='prepared'){
  if(!cropData.length)return;const payload={id:activeScanSessionId||undefined,status,nextPanel:activeScanNextPanel,records:activeScanRecords,crops:cropData,photos:scanFiles.map(entry=>({id:entry.id,name:entry.file.name,url:entry.url?.startsWith('data:')?entry.url:''}))};
  try{const response=await fetch(`${serviceBase()}/scan-sessions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});if(response.ok){const result=await response.json();activeScanSessionId=result.session.id;loadScanHistory()}}catch(error){console.warn('Scan checkpoint failed',error)}
}
async function loadScanHistory(){
  const list=document.querySelector('#scan-history-list');try{const response=await fetch(`${serviceBase()}/scan-sessions`,{signal:AbortSignal.timeout(8000)});const sessions=(await response.json()).sessions||[];list.innerHTML=sessions.length?sessions.slice(0,5).map(session=>`<button type="button" data-resume-scan="${escapeHtml(session.id)}"><strong>${session.status==='complete'?'Review':'Resume'} ${session.photos?.length||0} photo${session.photos?.length===1?'':'s'}</strong><span>${session.records?.length||0} titles · ${new Date(session.updatedAt).toLocaleString()}</span></button>`).join(''):'<span class="muted">No saved scans yet.</span>';list.dataset.sessions=JSON.stringify(sessions)}catch{list.innerHTML='<span class="muted">Scan history is unavailable while the local service is offline.</span>'}
}
document.querySelector('#scan-history-list').addEventListener('click',event=>{const button=event.target.closest('[data-resume-scan]');if(!button)return;const sessions=JSON.parse(event.currentTarget.dataset.sessions||'[]');const session=sessions.find(item=>item.id===button.dataset.resumeScan);if(!session)return;scanFiles.forEach(entry=>{if(entry.url?.startsWith('blob:'))URL.revokeObjectURL(entry.url)});scanFiles.length=0;cropData.length=0;(session.photos||[]).forEach((photo,index)=>scanFiles.push({id:photo.id||`restored-${index}`,key:`restored-${index}`,file:{name:photo.name||`Photo ${index+1}`},url:photo.url||(session.crops||[]).find(crop=>crop.fileId===photo.id)?.dataUrl||''}));cropData.push(...(session.crops||[]));activeScanSessionId=session.id;activeScanNextPanel=Math.min(Number(session.nextPanel||0),cropData.length);activeScanRecords=session.records||[];dropzone.style.display='none';photoQueue.hidden=false;autoScan.hidden=false;renderPhotoQueue();renderPreparedPanels();if(activeScanRecords.length)renderVisionRecords(activeScanRecords);document.querySelector('#vision-status').textContent=session.status==='complete'||activeScanNextPanel>=cropData.length?'Saved scan restored for review.':`Resumed at panel ${activeScanNextPanel+1} of ${cropData.length}.`;autoScan.scrollIntoView({behavior:'smooth',block:'start'})});
document.querySelector('#choose-photos').addEventListener('click',()=>spineInput.click());
document.querySelector('#add-more-photos').addEventListener('click',()=>spineInput.click());
['dragenter','dragover'].forEach(event=>dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.add('dragging')}));
['dragleave','drop'].forEach(event=>dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.remove('dragging')}));
dropzone.addEventListener('drop',e=>addSpineFiles([...e.dataTransfer.files])); spineInput.addEventListener('change',e=>addSpineFiles([...e.target.files]));
function loadImage(source){return new Promise((resolve,reject)=>{const image=new Image();const objectUrl=typeof source==='string'?'':URL.createObjectURL(source);image.onload=()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);resolve(image)};image.onerror=error=>{if(objectUrl)URL.revokeObjectURL(objectUrl);reject(error)};image.src=objectUrl||source})}
function renderSpinePanel(source,x,shelfTop,shelfHeight,panelWidth,options={}){
  const widthFactor=Number(options.widthFactor)||1;
  const requestedWidth=Math.max(1,Math.min(source.width,Math.round(panelWidth*widthFactor)));
  const center=x+panelWidth/2;
  const left=Math.max(0,Math.min(Math.max(0,source.width-requestedWidth),Math.round(center-requestedWidth/2)));
  const naturalWidth=shelfHeight;
  const naturalHeight=requestedWidth;
  const maxLong=Number(options.maxLong)||1536;
  const maxShort=Number(options.maxShort)||256;
  const enlargement=Math.min(Number(options.enlargementCap)||2,maxLong/Math.max(1,naturalWidth),maxShort/Math.max(1,naturalHeight));
  const horizontal=document.createElement('canvas');
  horizontal.width=Math.max(1,Math.round(naturalWidth*enlargement));
  horizontal.height=Math.max(1,Math.round(naturalHeight*enlargement));
  const ctx=horizontal.getContext('2d');
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.translate(horizontal.width/2,horizontal.height/2);
  ctx.rotate(Number.isFinite(Number(options.rotation))?Number(options.rotation):-Math.PI/2);
  ctx.filter=options.enhanced?'grayscale(1) contrast(1.5) brightness(1.06)':'contrast(1.12) saturate(.9)';
  ctx.drawImage(source,left,shelfTop,requestedWidth,shelfHeight,-naturalHeight*enlargement/2,-naturalWidth*enlargement/2,naturalHeight*enlargement,naturalWidth*enlargement);
  return horizontal.toDataURL('image/jpeg',options.enhanced ? .92 : .86);
}
async function detectSpines(file){
  const image=await loadImage(file);
  const source=document.createElement('canvas');
  const scale=Math.min(1,1600/image.width);
  source.width=Math.round(image.width*scale);
  source.height=Math.round(image.height*scale);
  source.getContext('2d').drawImage(image,0,0,source.width,source.height);

  let detection;
  try{
    const response=await fetch(`${serviceBase()}/segment-spines`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:source.toDataURL('image/jpeg',.88)}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Spine detection returned ${response.status}`);
    detection=await response.json();
    if(!Array.isArray(detection.segments)||!detection.segments.length)throw new Error('No spine boundaries were returned');
  }catch(error){
    console.warn('Using overlapping shelf sections because automatic spine boundaries were unavailable',error);
    const shelfTop=Math.round(source.height*.025);const shelfHeight=Math.round(source.height*.94);
    const panelWidth=Math.max(1,Math.min(source.width,Math.max(105,Math.min(220,Math.round(source.width*.15)))));const stride=Math.max(1,Math.round(panelWidth*.72));const starts=[];
    for(let x=0;x<source.width-panelWidth;x+=stride)starts.push(x);starts.push(Math.max(0,source.width-panelWidth));
    detection={sourceWidth:source.width,sourceHeight:source.height,shelfTop,shelfHeight,boundaryCount:0,segments:[...new Set(starts)].slice(0,12).map(x=>({x,panelWidth,spineCount:0}))};
  }
  const coordinateScale=source.width/Math.max(1,Number(detection.sourceWidth)||source.width);
  const shelfTop=Math.round((Number(detection.shelfTop)||0)*coordinateScale);
  const shelfHeight=Math.min(source.height-shelfTop,Math.round((Number(detection.shelfHeight)||source.height)*coordinateScale));
  return detection.segments.map((segment,index)=>{
    const x=Math.round(Number(segment.x)*coordinateScale);const panelWidth=Math.max(1,Math.round(Number(segment.panelWidth)*coordinateScale));
    return {
    dataUrl:renderSpinePanel(source,x,shelfTop,shelfHeight,panelWidth,{maxLong:1800,maxShort:280}),
    file:file.name,
    index:index+1,
    x,
    panelWidth,
    shelfTop,
    shelfHeight,
    sourceWidth:source.width,
    sourceHeight:source.height,
    spineCount:Number(segment.spineCount)||0,
    boundaryCount:Number(detection.boundaryCount)||0,
  }});
}
function renderPhotoQueue(){
  photoQueue.hidden=!scanFiles.length;
  document.querySelector('#photo-count').textContent=`${scanFiles.length} photo${scanFiles.length===1?'':'s'} queued`;
  document.querySelector('#add-more-photos').disabled=scanFiles.length>=20||bulkScanRunning;
  photoStrip.innerHTML=scanFiles.map((entry,index)=>`<div class="photo-queue-item"><img class="photo-thumb" src="${entry.url}" alt="${escapeHtml(entry.file.name)}"><button type="button" data-remove-photo="${entry.id}" aria-label="Remove ${escapeHtml(entry.file.name)}">×</button><span>${index+1}</span></div>`).join('');
}
function renderPreparedPanels(){
  detectedCrops.innerHTML=cropData.length?cropData.map((crop,i)=>`<div class="detected-crop"><img src="${crop.dataUrl}" alt="Automatic spine group ${i+1}"><label>${escapeHtml(crop.fileName)} · group ${crop.index}${crop.spineCount?` · ~${crop.spineCount} spines`:''}</label></div>`).join(''):'<div class="no-results">No spine groups prepared.</div>';
  document.querySelector('#crop-photo-label').textContent=`${cropData.length} spine groups from ${scanFiles.length} photo${scanFiles.length===1?'':'s'}`;
  document.querySelector('#run-scan').disabled=!cropData.length||bulkScanRunning;
  document.querySelector('#run-vision').disabled=!cropData.length||bulkScanRunning;
}
async function addSpineFiles(files){
  if(bulkScanRunning)return;
  const existingKeys=new Set(scanFiles.map(entry=>entry.key));
  const available=20-scanFiles.length;
  const fresh=files.filter(file=>file.type.startsWith('image/')).filter(file=>{const key=`${file.name}|${file.size}|${file.lastModified}`;if(existingKeys.has(key))return false;existingKeys.add(key);return true}).slice(0,available);
  spineInput.value='';
  if(!fresh.length)return;
  if(!scanFiles.length){activeScanSessionId='';activeScanNextPanel=0;activeScanRecords=[]}
  dropzone.style.display='none';photoQueue.hidden=false;autoScan.hidden=false;
  detectedCrops.innerHTML='<div class="no-results">Preparing new shelf photos for bulk scanning…</div>';
  for(const file of fresh){
    const entry={id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,key:`${file.name}|${file.size}|${file.lastModified}`,file,url:URL.createObjectURL(file)};
    scanFiles.push(entry);renderPhotoQueue();
    const regions=await detectSpines(file);
    regions.forEach(region=>cropData.push({...region,fileId:entry.id,fileName:file.name}));
  }
  renderPhotoQueue();renderPreparedPanels();saveScanCheckpoint('prepared');
}
photoStrip.addEventListener('click',event=>{
  const button=event.target.closest('[data-remove-photo]');if(!button||bulkScanRunning)return;
  const index=scanFiles.findIndex(entry=>entry.id===button.dataset.removePhoto);if(index<0)return;
  const [removed]=scanFiles.splice(index,1);URL.revokeObjectURL(removed.url);
  for(let i=cropData.length-1;i>=0;i--)if(cropData[i].fileId===removed.id)cropData.splice(i,1);
  if(!scanFiles.length){photoQueue.hidden=true;autoScan.hidden=true;dropzone.style.display='grid'}
  renderPhotoQueue();renderPreparedPanels();
});
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)})}
async function rotateWholePhoto(file){const image=await loadImage(file);const canvas=document.createElement('canvas');canvas.width=image.height;canvas.height=image.width;const ctx=canvas.getContext('2d');ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(Math.PI/2);ctx.filter='contrast(1.15)';ctx.drawImage(image,-image.width/2,-image.height/2);return canvas.toDataURL('image/jpeg',.94)}
function titleCaseWords(value){
  const title=(value||'').trim().toLocaleLowerCase();
  return title.replace(/(^|[\s\-–—/([{“‘])([\p{L}\p{N}])/gu,(_,prefix,letter)=>prefix+letter.toLocaleUpperCase());
}
function normalizeVisionText(value,role=''){
  let text=String(value||'').toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  if(role==='artist')text=text.replace(/^the\s+/,'');
  return text;
}
function isPlaceholderVisionText(value){return new Set(['','...','..','.','unknown','n a','none','artist','title','short visible text','exact words visibly read']).has(normalizeVisionText(value))}
function isMetaVisionEvidence(value){const text=normalizeVisionText(value);return ['the image is','image is not','spine has','spine of the book','clear legible','not clear enough','one narrow vinyl spine','written on it'].some(phrase=>text.includes(phrase))}
function visionEvidenceSupport(value,evidence){
  const valueTokens=normalizeVisionText(value).split(' ').filter(token=>token.length>2);const evidenceTokens=new Set(normalizeVisionText(evidence).split(' ').filter(token=>token.length>2));
  if(!valueTokens.length||!evidenceTokens.size)return 0;return valueTokens.filter(token=>evidenceTokens.has(token)).length/valueTokens.length;
}
function visionTextSimilarity(left,right,role=''){
  const a=normalizeVisionText(left,role);const b=normalizeVisionText(right,role);
  if(!a||!b)return 0;
  if(a===b)return 1;
  if(Math.min(a.length,b.length)<3)return 0;
  const previous=Array.from({length:b.length+1},(_,index)=>index);
  for(let row=1;row<=a.length;row++){
    let diagonal=previous[0];previous[0]=row;
    for(let column=1;column<=b.length;column++){
      const above=previous[column];
      previous[column]=a[row-1]===b[column-1]?diagonal+0:Math.min(previous[column]+1,previous[column-1]+1,diagonal+1);
      diagonal=above;
    }
  }
  const editScore=1-previous[b.length]/Math.max(a.length,b.length);
  const leftTokens=new Set(a.split(' '));const rightTokens=new Set(b.split(' '));
  const overlap=[...leftTokens].filter(token=>rightTokens.has(token)).length;
  const tokenScore=overlap/Math.max(leftTokens.size,rightTokens.size);
  return Math.max(editScore,tokenScore);
}
function visionRecordsMatch(left,right){
  const leftArtist=normalizeVisionText(left.artist,'artist');const rightArtist=normalizeVisionText(right.artist,'artist');
  const leftTitle=normalizeVisionText(left.title);const rightTitle=normalizeVisionText(right.title);
  if(leftArtist&&rightArtist&&leftTitle&&rightTitle){
    const artistScore=visionTextSimilarity(left.artist,right.artist,'artist');
    const titleScore=visionTextSimilarity(left.title,right.title);
    return artistScore>=.82&&titleScore>=.78&&artistScore+titleScore>=1.68;
  }
  // Do not merge a partial result into a complete result: two albums by the
  // same artist, or two artists with the same title, are both common.
  if(leftArtist&&rightArtist&&!leftTitle&&!rightTitle)return visionTextSimilarity(left.artist,right.artist,'artist')>=.96;
  if(leftTitle&&rightTitle&&!leftArtist&&!rightArtist)return visionTextSimilarity(left.title,right.title)>=.96;
  return false;
}
function visionRecordQuality(item){
  const confidence=Math.max(0,Math.min(1,Number(item.confidence)||0));
  return (item.artist?1:0)+(item.title?1:0)+confidence+(item.evidence?.trim()?0.05:0)+(item.corroborated?2:0)-(item.fragmentOnly?.5:0);
}
function mergeVisionRecords(existing,candidate){
  const preferred=visionRecordQuality(candidate)>visionRecordQuality(existing)?candidate:existing;
  const merged={...preferred};
  if(!merged.artist&&candidate.artist)merged.artist=candidate.artist;
  if(!merged.title&&candidate.title)merged.title=candidate.title;
  if(!merged.evidence&&candidate.evidence)merged.evidence=candidate.evidence;
  merged.confidence=Math.max(Number(existing.confidence)||0,Number(candidate.confidence)||0);
  return merged;
}
function dedupeVisionRecords(items){
  const unique=[];
  for(const originalItem of items||[]){
    if(!originalItem||typeof originalItem!=='object')continue;
    let artist=titleCaseWords(String(originalItem.artist||''));
    let title=titleCaseWords(String(originalItem.title||''));
    let evidence=String(originalItem.evidence||'').trim();
    const ocrText=String(originalItem.ocrText||'').trim();
    if(isPlaceholderVisionText(artist))artist='';if(isPlaceholderVisionText(title))title='';if(isPlaceholderVisionText(evidence)||isMetaVisionEvidence(evidence))evidence='';
    if(normalizeVisionText(artist)&&normalizeVisionText(artist)===normalizeVisionText(title))title='';
    if(evidence){if(artist&&visionEvidenceSupport(artist,evidence)<.34)artist='';if(title&&visionEvidenceSupport(title,evidence)<.34)title=''}
    if(!normalizeVisionText(artist)&&!normalizeVisionText(title)&&normalizeVisionText(evidence).length<4)continue;
    let confidence=Number(originalItem.confidence);if(!Number.isFinite(confidence))confidence=0;if(confidence>1)confidence/=100;
    const corroborated=Boolean(ocrText&&(visionEvidenceSupport(artist,ocrText)>=.34||visionEvidenceSupport(title,ocrText)>=.34||visionEvidenceSupport(evidence,ocrText)>=.34));
    const item={...originalItem,artist,title,confidence:Math.max(0,Math.min(1,confidence)),evidence,ocrText,corroborated,fragmentOnly:!artist&&!title};
    const existing=unique.find(entry=>visionRecordsMatch(entry.item,item));
    const evidenceMatch=!artist&&!title&&unique.find(entry=>!entry.item.artist&&!entry.item.title&&visionTextSimilarity(entry.item.evidence,evidence)>=.9);
    if(existing)existing.item=mergeVisionRecords(existing.item,item);
    else if(evidenceMatch)evidenceMatch.item=mergeVisionRecords(evidenceMatch.item,item);
    else unique.push({item});
  }
  return unique.map(entry=>entry.item);
}
function buildVisionShortlist(items){
  const clean=dedupeVisionRecords(items);const groups=new Map();
  clean.forEach((item,index)=>{const key=item.groupId||`ungrouped-${index}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item)});
  const shortlist=[];for(const group of groups.values()){group.sort((left,right)=>visionRecordQuality(right)-visionRecordQuality(left));if(group[0])shortlist.push(group[0]);shortlist.push(...group.slice(1).filter(item=>item.corroborated).slice(0,1))}
  return shortlist.slice(0,24);
}
const scanReleaseMatches=new Map();const scanReadings=new Map();let scanDiscogsUnavailable='';
function renderScanRows(items,source='VIS'){
  scanReleaseMatches.clear();scanReadings.clear();scanDiscogsUnavailable='';
  document.querySelector('#match-list').innerHTML=items.length?items.map((item,index)=>{const id=globalThis.crypto?.randomUUID?.()||`scan-${Date.now()}-${index}`;scanReadings.set(id,item);return `<article class="match-row" data-scan-id="${id}"><input class="match-check" type="checkbox" ${item.corroborated?'checked':''} aria-label="Add this record"><span class="match-cover cover-${(index%6)+1}">${source}</span><span class="match-edit"><input aria-label="Album title" value="${escapeHtml(item.title||'')}"><input aria-label="Artist" value="${escapeHtml(item.artist||'')}" placeholder="Unknown artist"><small>${source==='VIS'?`${item.fragmentOnly?'Text fragment':`${Math.round((Number(item.confidence)||0)*100)}% vision confidence`}${item.corroborated?' · OCR confirmed':''}${item.evidence?` · read “${escapeHtml(item.evidence)}”`:''}`:'OCR result · check spelling'}</small></span><span class="release-match"><span class="release-match-status">Waiting to match…</span><select class="release-select" aria-label="Discogs pressing" hidden></select><button class="scan-match-button" type="button">Find release</button></span></article>`}).join(''):'<div class="no-results">No titles were returned.</div>';
  if(items.length)setTimeout(autoMatchScanRows,0);
}
function rankScanCandidates(candidates,artist,title,evidence,ocrText=''){
  const evidenceText=normalizeVisionText(`${evidence} ${ocrText}`);const evidenceTokens=new Set(evidenceText.split(' ').filter(token=>token.length>2));
  return candidates.map(release=>{const names=splitDiscogsTitle(release.title);let score=0,weight=0;
    if(artist){score+=visionTextSimilarity(artist,names.artist,'artist')*.48;weight+=.48}
    if(title){score+=visionTextSimilarity(title,names.title)*.52;weight+=.52}
    if(evidenceTokens.size){const releaseTokens=new Set(normalizeVisionText(release.title).split(' '));const overlap=[...evidenceTokens].filter(token=>releaseTokens.has(token)).length/evidenceTokens.size;score+=overlap*.22;weight+=.22}
    return {...release,_scanScore:weight?score/weight:0};
  }).sort((left,right)=>right._scanScore-left._scanScore);
}
function updateScanReleaseChoice(row){
  const state=scanReleaseMatches.get(row.dataset.scanId);if(!state)return;
  const select=row.querySelector('.release-select');const release=state.candidates.find(item=>String(item.id)===String(select.value))||state.candidates[0];state.selected=release;
  const cover=row.querySelector('.match-cover');cover.classList.toggle('has-artwork',Boolean(release.coverUrl));cover.innerHTML=release.coverUrl?`<img src="${escapeHtml(release.coverUrl)}" alt="" loading="lazy">`:'VIS';
  const artistInput=row.querySelector('[aria-label="Artist"]');const titleInput=row.querySelector('[aria-label="Album title"]');const artist=artistInput.value;const title=titleInput.value;
  const duplicate=records.some(record=>String(record.discogsReleaseId||'')===String(release.id)||recordKey(record.artist,record.title)===recordKey(artist,title));
  row.querySelector('.release-match-status').innerHTML=`<strong>${duplicate?'Already in collection':'Suggested pressing'}</strong><small>${escapeHtml(release.year||'Unknown year')} · ${escapeHtml(release.country||'Unknown country')} · ${escapeHtml(release.label||'Unknown label')} · ${escapeHtml(release.catno||'No cat. no.')}</small>`;
  row.classList.toggle('possible-existing',duplicate);
}
async function searchScanRow(row){
  const status=row.querySelector('.release-match-status');const button=row.querySelector('.scan-match-button');const select=row.querySelector('.release-select');
  const artist=row.querySelector('[aria-label="Artist"]').value.trim();const title=row.querySelector('[aria-label="Album title"]').value.trim();const reading=scanReadings.get(row.dataset.scanId)||{};const evidence=String(reading.evidence||'').trim();const ocrText=String(reading.ocrText||'').trim();
  if(!artist&&!title&&!evidence){status.textContent='Add an artist, title or readable fragment to search.';return}
  if(scanDiscogsUnavailable){status.textContent=scanDiscogsUnavailable;button.textContent='Retry';return}
  button.disabled=true;button.textContent='Searching…';status.textContent='Searching Discogs…';select.hidden=true;
  try{
    const queries=[];if(artist||title)queries.push(new URLSearchParams({artist,title}));if(artist&&title)queries.push(new URLSearchParams({title}));if(evidence)queries.push(new URLSearchParams({q:evidence.slice(0,120)}));const catalogueHints=[...ocrText.toLocaleUpperCase().replace(/[^A-Z0-9]+/g,' ').matchAll(/\b[A-Z]{1,5}\s+\d{2,6}\b/g)].map(match=>match[0]).slice(0,2);catalogueHints.forEach(q=>queries.push(new URLSearchParams({q})));if(!queries.length)queries.push(new URLSearchParams({q:[artist,title,evidence].filter(Boolean).join(' ')}));
    let candidates=[];
    for(const params of queries){const response=await fetch(`${serviceBase()}/discogs/search?${params}`,{signal:AbortSignal.timeout(25000)});const result=await response.json();if(!response.ok){if(result.setupRequired){scanDiscogsUnavailable='Add your Discogs token, then restart the local server.';throw new Error(scanDiscogsUnavailable)}throw new Error(result.error||`Search returned ${response.status}`)}candidates=rankScanCandidates([...candidates,...(result.releases||[]).filter(release=>!candidates.some(existing=>String(existing.id)===String(release.id)))],artist,title,evidence,ocrText);if(candidates[0]?._scanScore>=.72)break}
    candidates=candidates.slice(0,6);if(!candidates.length){status.textContent='No vinyl release found. Edit the text and retry.';return}
    scanReleaseMatches.set(row.dataset.scanId,{candidates,selected:candidates[0]});
    select.innerHTML=candidates.map(release=>`<option value="${release.id}">${escapeHtml(release.title)} · ${escapeHtml(release.year||'—')} · ${escapeHtml(release.country||'—')} · ${escapeHtml(release.catno||'no cat. no.')}</option>`).join('');select.hidden=false;updateScanReleaseChoice(row);
  }catch(error){status.textContent=error.name==='TimeoutError'?'Discogs search timed out. Retry this row.':error.message}
  finally{button.disabled=false;button.textContent='Search again'}
}
async function autoMatchScanRows(){
  for(const row of document.querySelectorAll('#match-list .match-row')){if(scanDiscogsUnavailable){row.querySelector('.release-match-status').textContent=scanDiscogsUnavailable;continue}await searchScanRow(row)}
}
document.querySelector('#match-list').addEventListener('click',event=>{const button=event.target.closest('.scan-match-button');if(button){scanDiscogsUnavailable='';searchScanRow(button.closest('.match-row'))}});
document.querySelector('#match-list').addEventListener('change',event=>{if(event.target.matches('.release-select'))updateScanReleaseChoice(event.target.closest('.match-row'));if(event.target.matches('.match-edit input')){const row=event.target.closest('.match-row');scanReleaseMatches.delete(row.dataset.scanId);row.querySelector('.release-select').hidden=true;row.querySelector('.release-match-status').textContent='Text changed — search again.';row.classList.remove('possible-existing')}});
async function createAdaptiveRetryImage(crop){
  const entry=scanFiles.find(item=>item.id===crop.fileId);
  if(entry?.file?.type?.startsWith('image/')&&Number.isFinite(Number(crop.x))&&Number.isFinite(Number(crop.panelWidth))){
    const image=await loadImage(entry.file);
    const source=document.createElement('canvas');
    const baseScale=Math.min(1,1600/image.width);
    const scale=Math.min(1,2400/image.width);
    source.width=Math.round(image.width*scale);
    source.height=Math.round(image.height*scale);
    source.getContext('2d').drawImage(image,0,0,source.width,source.height);
    const coordinateScale=scale/baseScale;
    const retryX=Number(crop.x)*coordinateScale;
    const retryWidth=Number(crop.panelWidth)*coordinateScale;
    return renderSpinePanel(source,retryX,0,source.height,retryWidth,{widthFactor:1.35,enhanced:true,rotation:Math.PI/2,maxLong:2048,maxShort:384});
  }
  const image=await loadImage(crop.dataUrl);
  const enhanced=document.createElement('canvas');
  enhanced.width=image.width;enhanced.height=image.height;
  const context=enhanced.getContext('2d');
  context.translate(image.width/2,image.height/2);
  context.rotate(Math.PI);
  context.filter='grayscale(1) contrast(1.5) brightness(1.06)';
  context.drawImage(image,-image.width/2,-image.height/2);
  return enhanced.toDataURL('image/jpeg',.92);
}
async function readRetryOcr(image){
  if(!window.Tesseract)return '';
  try{
    const result=await Tesseract.recognize(image,'eng',{config:{tessedit_pageseg_mode:'11'}});
    return String(result.data?.text||'').replace(/\s+/g,' ').trim().slice(0,500);
  }catch{return ''}
}
function visionNeedsRetry(items,raw=''){
  const valid=dedupeVisionRecords(items);
  if(!valid.length)return true;
  const complete=valid.filter(item=>String(item.artist||'').trim()&&String(item.title||'').trim());
  return !complete.length||valid.some(item=>item.fragmentOnly)||(String(raw||'').includes('[')&&!String(raw||'').includes(']'));
}
async function requestVisionPanel(image,prompt){
  const response=await fetch(`${serviceBase()}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,prompt}),signal:AbortSignal.timeout(240000)});
  if(!response.ok){let detail=await response.text();try{detail=JSON.parse(detail).error||detail}catch{}throw new Error(detail||`Vision returned ${response.status}`)}
  return response.json();
}
function renderVisionRecords(records,raw=''){const clean=buildVisionShortlist(records);const status=document.querySelector('#vision-status');status.hidden=false;status.className=`vision-status ${clean.length?'success':'error'}`;status.textContent=clean.length?`Finished: ${clean.length} strongest candidate${clean.length===1?'':'s'} found across ${scanFiles.length} photo${scanFiles.length===1?'':'s'}. Matching visible text to releases now…`:`The model completed every spine group but returned no supported records. Raw responses:\n${raw||'(empty response)'}`;scanResults.hidden=false;document.querySelector('#match-count').textContent=clean.length;renderScanRows(clean,'VIS');scanResults.scrollIntoView({behavior:'smooth',block:'start'})}
document.querySelector('#run-vision').addEventListener('click',async()=>{
  const button=document.querySelector('#run-vision');
  const status=document.querySelector('#vision-status');
  const prompt='This is ONE enlarged horizontal, spine-aligned group cropped from a vinyl shelf photo. It contains only a few adjacent record spines and the lettering should run horizontally. Inspect the ENTIRE image from left to right and read every distinct spine with genuinely visible lettering. Return ONLY a JSON array with at most 6 objects. Every object must have the keys artist, title, confidence and evidence. Evidence must quote up to four words actually visible on that spine. Use an empty string for an unreadable artist or title. Do not copy field names or instructions into values, do not use ellipses as values, and do not infer from colour, artwork, neighbours or general knowledge. Return [] when no useful text is visible.';
  const retryPrompt='This is an enhanced opposite-orientation retry of ONE narrow vinyl-spine group. The first reading was empty or uncertain. Inspect the entire image again, including its edges, and read every distinct spine with genuinely visible lettering. Return ONLY a JSON array with at most 6 objects using the keys artist, title, confidence and evidence. Evidence must quote up to four words visibly present. Use empty strings for unreadable fields. Never use ellipses or instruction text as values, never guess, and return [] when the image does not support a record.';
  bulkScanRunning=true;
  renderPhotoQueue();
  renderPreparedPanels();
  status.hidden=false;
  status.className='vision-status';
  let records=[...activeScanRecords];
  const raw=[];
  const failures=[];
  try{
    const health=await fetch(`${serviceBase()}/health`,{signal:AbortSignal.timeout(5000)});
    if(!health.ok)throw new Error('The local vision service did not answer.');
    for(let i=activeScanNextPanel;i<cropData.length;i++){
      const crop=cropData[i];
      const photoIndex=scanFiles.findIndex(entry=>entry.id===crop.fileId);
      const photoLabel=photoIndex>=0?`photo ${photoIndex+1} of ${scanFiles.length}`:crop.fileName;
      const progress=`Reading ${photoLabel} · spine group ${crop.index} (${i+1}/${cropData.length} total)`;
      status.textContent=`${progress}…\nFound ${dedupeVisionRecords(records).length} possible records so far. Keep this tab open.`;
      button.textContent=`◌ ${progress}…`;
      try{
        const primaryOcr=await readRetryOcr(crop.dataUrl);
        const result=await requestVisionPanel(crop.dataUrl,prompt);
        let panelRecords=(result.records||[]).map(item=>({...item,ocrText:primaryOcr,groupId:`${crop.fileId}:${crop.index}`,groupCapacity:crop.spineCount||0}));
        raw.push(`${crop.fileName} · group ${crop.index}: ${result.raw||'(empty)'}`);
        if(visionNeedsRetry(panelRecords,result.raw)){
          status.textContent=`${progress}…\nLow-confidence result; trying an enhanced crop and local OCR hint…`;
          button.textContent=`◌ ${progress} · retry…`;
          try{
            const retryImage=await createAdaptiveRetryImage(crop);
            const ocrHint=await readRetryOcr(retryImage);
            const assistedPrompt=ocrHint?`${retryPrompt}\nOptional local OCR hint (may be wrong; verify it against the image): ${ocrHint}`:retryPrompt;
            const retryResult=await requestVisionPanel(retryImage,assistedPrompt);
            raw.push(`${crop.fileName} · group ${crop.index} retry: ${retryResult.raw||'(empty)'}`);
            const combinedOcr=[primaryOcr,ocrHint].filter(Boolean).join(' ');const retryRecords=(retryResult.records||[]).map(item=>({...item,ocrText:combinedOcr,groupId:`${crop.fileId}:${crop.index}`,groupCapacity:crop.spineCount||0}));
            panelRecords=dedupeVisionRecords([...panelRecords,...retryRecords]);
          }catch(retryError){
            const retryMessage=retryError.name==='TimeoutError'?'timed out after four minutes':retryError.message;
            if(/model runner stopped|ran out of RAM|unexpected EOF/i.test(retryMessage))throw new Error(retryMessage);
            failures.push(`${crop.fileName} · group ${crop.index} retry ${retryMessage}`);
            raw.push(`${crop.fileName} · group ${crop.index} retry: ERROR — ${retryMessage}`);
          }
        }
        records.push(...panelRecords);
        activeScanRecords=dedupeVisionRecords(records);activeScanNextPanel=i+1;await saveScanCheckpoint(activeScanNextPanel>=cropData.length?'complete':'running');
      }catch(panelError){
        const message=panelError.name==='TimeoutError'?'timed out after four minutes':panelError.message;
        if(/model runner stopped|ran out of RAM|unexpected EOF/i.test(message))throw new Error(message);
        failures.push(`${crop.fileName} · group ${crop.index} ${message}`);
        raw.push(`${crop.fileName} · group ${crop.index}: ERROR — ${message}`);
      }
    }
    renderVisionRecords(records,raw.join('\n\n'));
    activeScanRecords=dedupeVisionRecords(records);activeScanNextPanel=cropData.length;saveScanCheckpoint('complete');
    if(failures.length&&records.length){status.textContent+=` ${failures.length} panel${failures.length===1?'':'s'} could not be read.`}
  }catch(error){
    status.className='vision-status error';
    status.textContent=`Local vision stopped: ${error.name==='TimeoutError'?'a panel took longer than four minutes':error.message}`;
    if(records.length)renderVisionRecords(records,raw.join('\n\n'));
    else{scanResults.hidden=false;document.querySelector('#match-count').textContent='0';document.querySelector('#match-list').innerHTML='<div class="no-results">See the scan status above.</div>'}
  }
  bulkScanRunning=false;
  renderPhotoQueue();
  renderPreparedPanels();
  button.textContent='◈ Find album titles locally';
});
function imageVariants(source){return new Promise((resolve,reject)=>{loadImage(source).then(image=>{const variants=[];[0,90,270].forEach(rotation=>{const rotatedWidth=rotation===0?image.width:image.height;const rotatedHeight=rotation===0?image.height:image.width;const scale=Math.max(2,Math.min(4,420/rotatedWidth));const canvas=document.createElement('canvas');canvas.width=Math.round(rotatedWidth*scale);canvas.height=Math.round(rotatedHeight*scale);const ctx=canvas.getContext('2d');ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(rotation*Math.PI/180);ctx.filter='grayscale(1) contrast(1.4)';ctx.drawImage(image,-image.width*scale/2,-image.height*scale/2,image.width*scale,image.height*scale);variants.push(canvas.toDataURL('image/jpeg',.95))});resolve(variants)}).catch(reject)})}
document.querySelector('#run-scan').addEventListener('click',async()=>{
  const button=document.querySelector('#run-scan');
  const selected=[...cropData];
  bulkScanRunning=true;renderPhotoQueue();renderPreparedPanels();
  button.innerHTML='<span>◌</span> Reading locally…';
  let extracted=[];let ocrError='';
  if(window.Tesseract){
    try{
      for(let cropIndex=0;cropIndex<selected.length;cropIndex++){
        const crop=selected[cropIndex];
        const photoIndex=scanFiles.findIndex(entry=>entry.id===crop.fileId);
        const photoLabel=photoIndex>=0?`Photo ${photoIndex+1}/${scanFiles.length}`:crop.fileName;
        for(const variant of await imageVariants(crop.dataUrl)){
          const result=await Tesseract.recognize(variant,'eng',{logger:message=>{if(message.status==='recognizing text')button.innerHTML=`<span>◌</span> ${photoLabel} · panel ${crop.index} · ${Math.round((message.progress||0)*100)}%`},config:{tessedit_pageseg_mode:'11'}});
          const text=result.data.text.replace(/\s+/g,' ').trim();if(text)extracted.push(text);
        }
      }
    }catch(error){ocrError=error.message||'The local OCR engine could not read these images.'}
  }else{ocrError='The local OCR engine did not load. Check that the device is online for the first Tesseract.js download, then try again.'}
  const candidates=extracted.flatMap(text=>text.split(/[\n|]+/).map(line=>line.trim()).filter(line=>line.length>2)).filter((line,index,all)=>all.indexOf(line)===index).slice(0,80);
  scanResults.hidden=false;document.querySelector('#match-count').textContent=candidates.length;
  renderScanRows(candidates.map(title=>({title,artist:''})),'OCR');if(!candidates.length)document.querySelector('#match-list').innerHTML=`<div class="no-results">${escapeHtml(ocrError||'No readable text found. Try a closer, brighter photo with the spines filling the frame.')}</div>`;
  activeScanRecords=candidates.map(title=>({title,artist:'',confidence:0,evidence:'OCR'}));activeScanNextPanel=cropData.length;saveScanCheckpoint('complete');
  bulkScanRunning=false;renderPhotoQueue();renderPreparedPanels();button.innerHTML='<span>✦</span> OCR fallback';scanResults.scrollIntoView({behavior:'smooth',block:'start'});
});
document.querySelector('#scan-again').addEventListener('click',()=>{
  scanFiles.forEach(entry=>URL.revokeObjectURL(entry.url));
  scanFiles.length=0;cropData.length=0;scanReleaseMatches.clear();activeScanSessionId='';activeScanNextPanel=0;activeScanRecords=[];bulkScanRunning=false;spineInput.value='';
  photoStrip.innerHTML='';detectedCrops.innerHTML='';photoQueue.hidden=true;autoScan.hidden=true;scanResults.hidden=true;dropzone.style.display='grid';
});
document.querySelector('#add-matches').addEventListener('click',()=>{
  const added=[];
  document.querySelectorAll('.match-row').forEach(row=>{
    if(!row.querySelector('.match-check:checked'))return;
    const release=scanReleaseMatches.get(row.dataset.scanId)?.selected;
    const releaseNames=release?splitDiscogsTitle(release.title):null;
    const title=releaseNames?.title||row.querySelector('[aria-label="Album title"]')?.value.trim()||'';
    const artist=releaseNames?.artist||row.querySelector('[aria-label="Artist"]')?.value.trim()||'';
    if(!title&&!artist)return;
    const releaseData=release?collectionDataFromRelease(release):{};
    const record=createCollectionRecord(artist,title,releaseData);
    records.push(record);added.push(record);
  });
  if(!added.length)return;
  saveRecords();showCollection();added.forEach(record=>{queueArtwork(record);queueDiscogsPrice(record)});
  toast.innerHTML=`${added.length} record${added.length===1?'':'s'} added to your collection <span>✓</span>`;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)
});
render();
hydrateCollection().then(()=>{records.filter(record=>!record.coverUrl&&record.artworkStatus!=='unavailable').forEach(record=>{record.artworkStatus='';queueArtwork(record)});records.forEach(queueDiscogsPrice)});
loadScanHistory();
