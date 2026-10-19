/* Γ.Ν. Βέροιας • Επαγγελματικές κάρτες • Τοπική, χωρίς backend, εφαρμογή. */
(() => {
  'use strict';
  const DB_NAME = 'GNVeriasCardsDB';
  const DB_VERSION = 1;
  const main = document.getElementById('mainContent');
  const toastEl = document.getElementById('toast');
  let db;
  let editingId = null;
  let draft = null;
  let photoURL = null;
  let listURLs = [];
  let ocrRunning = false;
  let phoneReviewCandidates = [];
  let activeCropCleanup = null;
  let toastTimeout;
  const greekMonths = ['Ιαν','Φεβ','Μαρ','Απρ','Μαΐ','Ιουν','Ιουλ','Αυγ','Σεπ','Οκτ','Νοε','Δεκ'];

  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const fmtDate = date => { const d = new Date(date); return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${greekMonths[d.getMonth()]} ${d.getFullYear()}`; };
  const initials = text => (String(text || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0]?.toLocaleUpperCase('el-GR') || '').join('') || '?');
  const stripForSearch = str => String(str || '').toLocaleLowerCase('el').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const safePhone = str => String(str || '').replace(/[^\d+]/g, '');
  // Για περισσότερα από ένα σταθερά, καλούμε μόνο το πρώτο, όχι τη συνένωσή τους.
  const firstCallablePhone = str => {
    const value = String(str || '');
    const match = value.match(/(?:\+?30[\s.()-]*)?(?:69(?:[\s.()-]*\d){8}|2(?:[\s.()-]*\d){9})/);
    return safePhone(match ? match[0] : value.split(/[/;,|]/)[0]);
  };
  const dataArray = v => Array.isArray(v) ? v : [];
  const nextId = () => (crypto?.randomUUID?.() || `card-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function toast(message) { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toastTimeout); toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 3600); }
  function tx(storeName, mode='readonly') { return db.transaction(storeName, mode).objectStore(storeName); }
  function request(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  function openDB() { return new Promise((resolve, reject) => { const r = indexedDB.open(DB_NAME, DB_VERSION); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', {keyPath:'id'}); if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', {keyPath:'key'}); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  const allContacts = () => request(tx('contacts').getAll());
  const getContact = id => request(tx('contacts').get(id));
  const putContact = item => request(tx('contacts','readwrite').put(item));
  const deleteContact = id => request(tx('contacts','readwrite').delete(id));

  const navActive = view => document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const releaseListURLs = () => { listURLs.forEach(u => URL.revokeObjectURL(u)); listURLs = []; };
  const releasePhotoURL = () => { if (photoURL) {URL.revokeObjectURL(photoURL);photoURL=null;} };

  async function showList(search='') {
    if (activeCropCleanup) activeCropCleanup();
    editingId = null; draft = null; releasePhotoURL(); releaseListURLs(); navActive('list');
    const contacts = (await allContacts()).sort((a,b) => new Date(b.updatedAt)-new Date(a.updatedAt));
    const assocCount = contacts.reduce((sum, item) => sum + dataArray(item.assignments).length, 0);
    const companyCount = new Set(contacts.map(c => c.company?.trim().toLowerCase()).filter(Boolean)).size;
    main.innerHTML = `
      <section class="hero"><div class="kicker">Ψηφιακό αρχείο συνεργατών</div><h1>Όλες οι κάρτες,<br>σε ένα σημείο.</h1><p>Φωτογράφισε, αναγνώρισε και βρες εύκολα τον τεχνικό για κάθε μηχάνημα.</p><button id="heroAdd" class="btn btn-light" type="button">＋ Νέα καταχώριση</button>
      <div class="stats"><span><strong>${contacts.length}</strong> κάρτες</span><span><strong>${companyCount}</strong> εταιρείες</span><span><strong>${assocCount}</strong> συσχετίσεις</span></div></section>
      <div class="section-head"><h2>Επαφές</h2><span class="secondary-text">Αναζήτηση παντού</span></div>
      <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="searchInput" type="search" placeholder="Όνομα, εταιρεία, τμήμα, μηχάνημα…" aria-label="Αναζήτηση" autocomplete="off" value="${esc(search)}"></label>
      <div class="section-head"><span class="secondary-text" id="resultsCount"></span></div><div class="cards-grid" id="contactsList"></div>`;
    document.getElementById('heroAdd').addEventListener('click', () => showForm());
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => renderResults(contacts,searchInput.value));
    renderResults(contacts,search);
    window.scrollTo({top:0,behavior:'instant'});
  }
  function renderResults(contacts, phrase='') {
    releaseListURLs();
    const list = document.getElementById('contactsList');
    if (!list) return;
    const needle = stripForSearch(phrase.trim());
    const selected = contacts.filter(c => stripForSearch([c.name,c.company,c.role,c.phone,c.mobile,c.fax,c.address,c.email,c.website,c.notes,c.rawText,...dataArray(c.assignments).flatMap(a=>[a.department,a.equipment])].join(' ')).includes(needle));
    document.getElementById('resultsCount').textContent = `${selected.length} από ${contacts.length} καταχωρίσεις`;
    if (!selected.length) {
      list.innerHTML = `<div class="empty-state"><span class="empty-icon">${contacts.length ? '⌕' : '▤'}</span><h3>${contacts.length ? 'Δεν βρέθηκαν κάρτες' : 'Το μητρώο είναι κενό'}</h3><p>${contacts.length ? 'Δοκίμασε διαφορετική λέξη ή αναζήτησε το τμήμα ή το μηχάνημα.' : 'Πάτησε «Νέα καταχώριση» για να φωτογραφίσεις την πρώτη κάρτα.'}</p>${!contacts.length?'<button type="button" class="btn btn-primary" id="emptyAdd">Προσθήκη κάρτας</button>':''}</div>`;
      document.getElementById('emptyAdd')?.addEventListener('click', () => showForm());
      return;
    }
    list.innerHTML = selected.map(c => {
      let imageHTML = `<div class="contact-thumb contact-initials">${esc(initials(c.name||c.company))}</div>`;
      if (c.photoBlob instanceof Blob) { const u = URL.createObjectURL(c.photoBlob); listURLs.push(u); imageHTML = `<img class="contact-thumb" src="${u}" alt="Κάρτα του ${esc(c.name||c.company)}">`; }
      const desc = dataArray(c.assignments).slice(0,2).map(a => `${a.department||'Τμήμα'}${a.equipment?' · '+a.equipment:''}`).join(' / ');
      const mobileCalls = [...new Set(phoneNumbersIn(c.mobile).filter(n=>n.startsWith('69')))].slice(0,4);
      const fixedCalls = [...new Set(String(c.phone||'').split(/[/;,|]/).map(firstCallablePhone).filter(Boolean))].slice(0,3);
      const callLinks = [...mobileCalls.map((number,i)=>`<a href="tel:${number}">📱 Κινητό${mobileCalls.length>1?' '+(i+1):''}</a>`),
        ...fixedCalls.map((number,i)=>`<a href="tel:${number}">☎ Σταθερό${fixedCalls.length>1?' '+(i+1):''}</a>`)];
      const mailLinks=splitEmailAddresses(c.email).slice(0,3).map((address,i)=>`<a href="mailto:${encodeURIComponent(address).replace('%40','@')}">✉ Email${splitEmailAddresses(c.email).length>1?' '+(i+1):''}</a>`);
      return `<article class="contact-card" tabindex="0" role="button" data-id="${esc(c.id)}" aria-label="Επεξεργασία ${esc(c.name||c.company)}">${imageHTML}<div class="contact-info"><h3>${esc(c.name||c.company||'Χωρίς όνομα')}</h3><div class="company">${esc(c.company||c.role||'Συνεργάτης')}</div><div class="contact-meta">${esc(desc||c.role||'Δεν έχουν δηλωθεί τμήματα / μηχανήματα')}</div><div class="quick-actions">${callLinks.join('')}${mailLinks.join('')}</div></div><span class="contact-arrow" aria-hidden="true">›</span></article>`;
    }).join('');
    list.querySelectorAll('.contact-card').forEach(card => {
      card.addEventListener('click', e => {if(!e.target.closest('a')) showForm(card.dataset.id);});
      card.addEventListener('keydown', e => {if(e.key==='Enter' || e.key===' ') {e.preventDefault();showForm(card.dataset.id);} });
    });
  }

  function newDraft() { return {id:null,name:'',company:'',role:'',phone:'',mobile:'',fax:'',address:'',email:'',website:'',assignments:[{department:'',equipment:''}],notes:'',rawText:'',photoBlob:null,createdAt:null,updatedAt:null}; }
  const field = (key,label,opts={}) => `<div class="field ${opts.full?'full':''}"><label for="f_${key}">${label}${opts.required?' <span class="badge-required">*</span>':''}</label><input id="f_${key}" name="${key}" type="${opts.type||'text'}" autocomplete="${opts.autocomplete||'off'}" placeholder="${esc(opts.placeholder||'')}" value="${esc(draft[key]||'')}"></div>`;
  function assignmentsHTML() {
    const rows = draft.assignments.length ? draft.assignments : [{department:'',equipment:''}];
    return rows.map((a,i) => `<div class="assignment" data-assignment="${i}"><div class="field-grid"><div class="field"><label for="d_${i}">Τμήμα</label><input id="d_${i}" data-k="department" list="knownDepartments" placeholder="π.χ. Ακτινολογικό" value="${esc(a.department||'')}"></div><div class="field"><label for="e_${i}">Μηχάνημα / σύστημα</label><input id="e_${i}" data-k="equipment" placeholder="π.χ. Ακτινογραφικό" value="${esc(a.equipment||'')}"></div></div>${rows.length>1?`<button type="button" class="remove-row" data-remove="${i}" aria-label="Αφαίρεση συσχέτισης">×</button>`:''}</div>`).join('');
  }
  function previewHTML() {
    if (draft?.photoBlob instanceof Blob) {photoURL = URL.createObjectURL(draft.photoBlob);return `<img src="${photoURL}" alt="Φωτογραφία επαγγελματικής κάρτας">`;}
    return `<div class="photo-placeholder"><span class="camera">▣</span><strong>Η κάρτα σου θα εμφανιστεί εδώ</strong><span>Τράβηξε φωτογραφία ή επίλεξε εικόνα</span></div>`;
  }
  async function showForm(id=null) {
    if (activeCropCleanup) activeCropCleanup();
    releasePhotoURL(); releaseListURLs(); editingId = id;
    draft = id ? await getContact(id) : newDraft();
    if (!draft) { toast('Δεν βρέθηκε η συγκεκριμένη κάρτα.'); return showList(); }
    draft.assignments = dataArray(draft.assignments).length ? draft.assignments : [{department:'',equipment:''}];
    navActive(id ? 'list' : 'new');
    main.innerHTML = `<div class="page-head"><button type="button" class="back-btn" id="backList" aria-label="Επιστροφή">‹</button><div><h1 class="page-title">${id?'Επεξεργασία κάρτας':'Νέα επαγγελματική κάρτα'}</h1><div class="sub">${id?'Διόρθωσε τα στοιχεία ή πρόσθεσε παρατηρήσεις':'Αυτόματη αναγνώριση και καταχώριση'}</div></div></div>
      <section class="panel"><h2>01 · Φωτογραφία κάρτας</h2><div class="photo-area" id="photoArea">${previewHTML()}</div><div class="photo-actions"><button type="button" class="btn btn-primary" id="takePhoto">📷 Φωτογράφιση</button><button type="button" class="btn btn-outline" id="choosePhoto">▧ Από συλλογή</button></div><input class="file-input" type="file" accept="image/*" capture="environment" id="cameraInput"><input class="file-input" type="file" accept="image/*" id="galleryInput"><div id="ocrStatus" class="ocr-bar ${draft.photoBlob?'':'hidden'}">${draft.photoBlob?'Μπορείς να επαναλάβεις την αναγνώριση αν χρειάζεται.':' '}<br><button class="btn btn-outline" id="retryOCR" type="button" ${!draft.photoBlob?'disabled':''}>↻ Αναγνώριση κειμένου</button></div><p class="hint">Έκδοση OCR 14: κανονική κάμερα POCO και crop πριν από το OCR, με προσεκτικό έλεγχο επωνυμίας. Διόρθωσε το πλαίσιο περικοπής με το δάχτυλο αν χρειάζεται. Διατηρούνται οι δύο αναγνώσεις (ελληνικά + αγγλικά και μόνο ελληνικά), με βελτίωση αντίθεσης. Κράτησε την κάρτα επίπεδη, χωρίς αντανακλάσεις, και γέμισε το κάδρο. Η αναγνώριση γίνεται στη συσκευή και απαιτεί διαδίκτυο για την αρχική λήψη των γλωσσών. Έλεγξε τα στοιχεία πριν από την αποθήκευση. Αν το όνομα είχε καταχωριστεί λάθος παλαιότερα, μπορείς να το σβήσεις και να ξαναπατήσεις OCR ή να διαλέξεις πρόταση.</p></section>
      <section class="panel"><h2>02 · Στοιχεία επικοινωνίας <small>— διορθώνονται</small></h2><div class="field-grid">${field('name','Ονοματεπώνυμο',{full:true,placeholder:'Όνομα και επώνυμο'})}<div id="nameSuggestions" class="name-suggestion-block"></div>${field('company','Εταιρεία',{full:true,placeholder:'Εταιρεία / προμηθευτής'})}<div id="companySuggestions" class="company-suggestion-block"></div>${field('role','Ιδιότητα',{full:true,placeholder:'π.χ. Τεχνικός'})}${field('phone','Σταθερά τηλέφωνα',{full:true,placeholder:'π.χ. 210 4809673 / 210 4809674'})}${field('mobile','Κινητά τηλέφωνα',{full:true,type:'tel',placeholder:'π.χ. 6980 569382 / 6945 770558'})}${field('fax','Fax',{type:'tel'})}<div id="faxSuggestions" class="fax-choice-block"></div><div class="phone-review-block" id="phoneReview"><button type="button" class="btn btn-outline" id="scanPhones">⌕ Επανέλεγχος μόνο τηλεφώνων</button><p class="hint">Αν λείπει κάποιος αριθμός, κάνε πρόσθετη ανάγνωση. Οι αβέβαιοι αριθμοί εμφανίζονται για επιβεβαίωση, όχι για αυτόματη αποθήκευση.</p><div id="phoneReviewResults" aria-live="polite"></div></div>${field('address','Διεύθυνση',{full:true,placeholder:'Οδός, αριθμός, Τ.Κ., πόλη'})}${field('email','Email (ένα ή περισσότερα)',{full:true,placeholder:'π.χ. name@company.gr / info@company.gr'})}${field('website','Ιστοσελίδα',{full:true,placeholder:'www.example.gr'})}</div></section>
      <section class="panel"><h2>03 · Τμήματα & μηχανήματα</h2><p class="panel-tip">Ο ίδιος τεχνικός μπορεί να υποστηρίζει πολλά μηχανήματα σε διαφορετικά τμήματα.</p><div id="assignments">${assignmentsHTML()}</div><datalist id="knownDepartments"><option value="Τεχνική Υπηρεσία"><option value="Ακτινολογικό"><option value="Χειρουργεία"><option value="ΜΕΘ"><option value="Καρδιολογικό"><option value="ΤΕΠ"><option value="Εργαστήρια"><option value="Φυσικοθεραπεία"><option value="Μικροβιολογικό"><option value="Αποστείρωση"><option value="Αιμοδοσία"><option value="Πληροφορική"></datalist><button type="button" class="btn btn-outline" id="addAssignment">＋ Προσθήκη μηχανήματος</button></section>
      <section class="panel"><h2>04 · Παρατηρήσεις</h2><div class="field"><label for="f_notes">Σημειώσεις / οδηγίες επικοινωνίας / ιστορικό</label><textarea id="f_notes" placeholder="π.χ. Συντηρεί τον υπέρηχο του ΤΕΠ. Τηλεφωνούμε πρώτα στο κινητό…">${esc(draft.notes||'')}</textarea></div><p class="hint">Μη γράφεις στοιχεία ασθενών ή άλλες ευαίσθητες πληροφορίες.</p><details class="raw-details"><summary>Προβολή του κειμένου OCR (για έλεγχο)</summary><div class="field"><textarea id="f_rawText" placeholder="Το αναγνωρισμένο κείμενο εμφανίζεται εδώ…">${esc(draft.rawText||'')}</textarea></div></details></section>
      <div class="action-bar"><button type="button" class="btn btn-primary btn-block" id="saveCard">✓ Αποθήκευση κάρτας</button>${id?'<button type="button" class="btn btn-danger" id="deleteCard" aria-label="Διαγραφή κάρτας">🗑</button>':''}</div><div id="formError" class="error-inline" aria-live="polite"></div>${id?`<div class="last-save">Τελευταία ενημέρωση: ${esc(fmtDate(draft.updatedAt))}</div>`:''}`;
    document.getElementById('backList').onclick = () => showList();
    document.getElementById('takePhoto').onclick = () => document.getElementById('cameraInput').click();
    document.getElementById('choosePhoto').onclick = () => document.getElementById('galleryInput').click();
    document.getElementById('cameraInput').onchange = async e => { const file=e.target.files[0]; e.target.value=''; await handlePhoto(file); };
    document.getElementById('galleryInput').onchange = async e => { const file=e.target.files[0]; e.target.value=''; await handlePhoto(file); };
    document.getElementById('retryOCR').onclick = () => processOCR();
    document.getElementById('scanPhones').onclick = () => scanPhonesOnly();
    phoneReviewCandidates = [];
    document.getElementById('addAssignment').onclick = () => { syncDraft(); draft.assignments.push({department:'',equipment:''}); document.getElementById('assignments').innerHTML = assignmentsHTML(); attachAssignmentButtons(); };
    attachAssignmentButtons();
    document.getElementById('f_phone').addEventListener('input', showFaxSuggestions);
    document.getElementById('f_fax').addEventListener('input', showFaxSuggestions);
    for(const key of ['phone','mobile','fax'])document.getElementById('f_'+key).addEventListener('input', renderPhoneReview);
    showFaxSuggestions();
    document.getElementById('saveCard').onclick = saveForm;
    document.getElementById('deleteCard')?.addEventListener('click',async () => { if(confirm('Να διαγραφεί οριστικά αυτή η επαγγελματική κάρτα;')) { await deleteContact(editingId);toast('Η κάρτα διαγράφηκε.');showList(); } });
    window.scrollTo({top:0,behavior:'instant'});
  }
  function attachAssignmentButtons() {
    document.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => {syncDraft();draft.assignments.splice(Number(btn.dataset.remove),1);document.getElementById('assignments').innerHTML=assignmentsHTML();attachAssignmentButtons();});
  }
  function syncDraft() {
    if (!draft) return;
    ['name','company','role','phone','mobile','fax','address','email','website','notes','rawText'].forEach(k => { const el = document.getElementById('f_'+k); if(el) draft[k]=el.value; });
    draft.assignments = [...document.querySelectorAll('[data-assignment]')].map(node => ({department:node.querySelector('[data-k="department"]').value, equipment:node.querySelector('[data-k="equipment"]').value}));
  }
  function applyDraftFields() {
    ['name','company','role','phone','mobile','fax','address','email','website','notes','rawText'].forEach(k => { const el = document.getElementById('f_'+k);if(el) el.value=draft[k]||''; });
  }
  // Αν το OCR δεν είδε τη λέξη FAX, η διόρθωση γίνεται με ένα άγγιγμα.
  // Η λειτουργία αυτή δεν σβήνει άλλα πεδία και δεν χρειάζεται νέο OCR.
  function phoneNumbersIn(value) {
    const matches = String(value||'').matchAll(/(?<!\d)(?:(?:\+|00)30[\s.()\-]*)?(?:69(?:[\s.()\-]*\d){8}|2(?:[\s.()\-]*\d){9})(?!\d)/g);
    return [...new Set([...matches].map(m => normalizedGreekPhone(m[0])).filter(Boolean))];
  }
  function normalizedGreekPhone(value) {
    // Μετατροπή μόνο μέσα σε υποψήφιο αριθμό, όχι στο υπόλοιπο κείμενο.
    let number=String(value||'').replace(/[ΟοOo]/g,'0').replace(/[ΙIl|]/g,'1').replace(/\D/g,'');
    if(number.startsWith('0030')&&number.length===14) number=number.slice(4);
    else if(number.startsWith('30')&&number.length===12) number=number.slice(2);
    return number.length===10 ? number : '';
  }
  function removePhoneFromFixed(fieldValue, faxNumber) {
    // Προτιμά τη διατήρηση των αρχικών διαχωριστικών όταν είναι δυνατόν.
    const parts=String(fieldValue||'').split(/\s*[/;,|]\s*/).map(p=>p.trim()).filter(Boolean);
    return parts.filter(p=>!phoneNumbersIn(p).includes(faxNumber)).join(' / ');
  }
  // OCR 14: αν το OCR διαβάσει 0 ως O/Ο ή 1 ως I/Ι/l, δεν πετάμε
  // ολόκληρο τον αριθμό. Οι τέτοιες διορθώσεις εμφανίζονται για έλεγχο.
  const tolerantPhonePattern = /(?<![\dΟοOoΙIl|])(?:(?:\+|00)30[\s.()\-]*)?(?:69(?:[\s.()\-]*[0-9ΟοOoΙIl|]){8}|2(?:[\s.()\-]*[0-9ΟοOoΙIl|]){9})(?![\dΟοOoΙIl|])/gu;
  function phoneHintsFromText(text, origin='OCR') {
    const result=[];
    for(const raw of String(text||'').split(/\r?\n/)) {
      let hit;
      tolerantPhonePattern.lastIndex=0;
      while((hit=tolerantPhonePattern.exec(raw))!==null){
        const number=normalizedGreekPhone(hit[0]);
        if(!/^(?:69\d{8}|2\d{9})$/.test(number))continue;
        const before=raw.slice(Math.max(0,hit.index-22),hit.index);
        const type=/(?:fax|φ[αά]ξ|facsimile)/iu.test(before)?'fax':number.startsWith('69')?'mobile':'phone';
        const uncertain=/[ΟοOoΙIl|]/u.test(hit[0]);
        result.push({number,type,uncertain,origin});
      }
    }
    return result;
  }
  function addPhoneReview(entries){
    const map=new Map(phoneReviewCandidates.map(c=>[c.number,c]));
    for(const entry of entries){
      if(!entry || !/^(?:69\d{8}|2\d{9})$/.test(entry.number))continue;
      const old=map.get(entry.number);
      if(!old || (old.uncertain && !entry.uncertain))map.set(entry.number,entry);
    }
    phoneReviewCandidates=[...map.values()].slice(0,12);
    renderPhoneReview();
  }
  function renderPhoneReview(){
    const box=document.getElementById('phoneReviewResults');if(!box)return;
    box.replaceChildren();
    const existing=new Set(['phone','mobile','fax'].flatMap(k=>phoneNumbersIn(document.getElementById('f_'+k)?.value||'')));
    const pending=phoneReviewCandidates.filter(c=>!existing.has(c.number));
    if(!pending.length)return;
    const title=document.createElement('div');title.className='hint';
    title.textContent='Πιθανοί επιπλέον αριθμοί — έλεγξέ τους πάνω στη φωτογραφία πριν τους προσθέσεις:';
    box.appendChild(title);
    for(const c of pending){
      const line=document.createElement('div');line.className='phone-review-row';
      const num=document.createElement('span');num.textContent=c.number+(c.uncertain?' · αβέβαιη ανάγνωση':'');line.appendChild(num);
      for(const type of (c.number.startsWith('69')?['mobile']:['phone','fax'])){
        const btn=document.createElement('button');btn.type='button';btn.className='phone-review-choice';
        btn.textContent=type==='mobile'?'＋ Κινητό':type==='fax'?'＋ Fax':'＋ Σταθερό';
        btn.onclick=()=>{
          const input=document.getElementById('f_'+type);if(!input)return;
          const prev=phoneNumbersIn(input.value);
          input.value=[...new Set([...prev,c.number])].join(' / ');
          if(draft)draft[type]=input.value;
          showFaxSuggestions();renderPhoneReview();toast('Προστέθηκε ο αριθμός. Επιβεβαίωσέ τον στην κάρτα.');
        };
        line.appendChild(btn);
      }
      box.appendChild(line);
    }
  }
  async function scanPhonesOnly(){
    if(!draft?.photoBlob||ocrRunning)return;
    syncDraft();ocrRunning=true;
    const button=document.getElementById('scanPhones');
    if(button){button.disabled=true;button.textContent='⌛ Έλεγχος αριθμών…';}
    let worker;
    try{
      const Tess=await loadTesseract();
      worker=await Tess.createWorker('eng',1);
      const picture=await prepareOCRImage(draft.photoBlob);
      await worker.setParameters({tessedit_pageseg_mode:Tess.PSM.SPARSE_TEXT,
        tessedit_char_whitelist:'0123456789+()/.:- OolI',preserve_interword_spaces:'1',user_defined_dpi:'300'});
      let numericText=(await worker.recognize(picture)).data?.text||'';
      // Εφεδρικό πέρασμα από την αυθεντική περικομμένη φωτογραφία χωρίς
      // φίλτρο αντίθεσης — ορισμένοι λεπτοί αριθμοί χάνονται στο grayscale.
      if(phoneHintsFromText(numericText).length<2){
        const natural=(await worker.recognize(draft.photoBlob)).data?.text||'';
        if(natural.trim())numericText+='\n'+natural;
      }
      addPhoneReview(phoneHintsFromText(numericText,'Αριθμοί OCR').map(c=>({...c,uncertain:true})));
      const additions=phoneHintsFromText(numericText);
      if(additions.length){
        draft.rawText=String(draft.rawText||'')+'\n\n--- Συμπληρωματική ανάγνωση αριθμών (απαιτεί έλεγχο) ---\n'+numericText;
        const rawField=document.getElementById('f_rawText');if(rawField)rawField.value=draft.rawText;
        toast('Ο επανέλεγχος ολοκληρώθηκε. Δες τους προτεινόμενους αριθμούς.');
      }else toast('Δεν βρέθηκαν επιπλέον αριθμοί. Δοκίμασε καθαρότερη φωτογραφία.');
    }catch(e){console.error('Number OCR',e);toast('Δεν μπόρεσε να ολοκληρωθεί ο επανέλεγχος αριθμών.');}
    finally{if(worker)try{await worker.terminate();}catch(_){}ocrRunning=false;
      if(button){button.disabled=false;button.textContent='⌕ Επανέλεγχος μόνο τηλεφώνων';}}
  }

  function showFaxSuggestions() {
    const slot=document.getElementById('faxSuggestions');
    const fixedInput=document.getElementById('f_phone');
    const faxInput=document.getElementById('f_fax');
    if(!slot||!fixedInput||!faxInput) return;
    slot.replaceChildren();
    const numbers=phoneNumbersIn(fixedInput.value).filter(n=>n.startsWith('2'));
    if(faxInput.value.trim()||!numbers.length)return;
    const hint=document.createElement('div');hint.className='hint';
    hint.textContent='Αν κάποιος από τους αριθμούς είναι fax, επίλεξέ τον για να μεταφερθεί από τα σταθερά:';
    slot.appendChild(hint);
    const choices=document.createElement('div');choices.className='fax-choices';
    for(const number of numbers) {
      const btn=document.createElement('button');btn.className='fax-choice';btn.type='button';
      btn.textContent='Fax: '+number;
      btn.addEventListener('click',()=>{
        fixedInput.value=removePhoneFromFixed(fixedInput.value,number);
        faxInput.value=number;
        if(draft) {draft.phone=fixedInput.value;draft.fax=number;}
        showFaxSuggestions();toast('Ο αριθμός μεταφέρθηκε στο Fax.');
      });
      choices.appendChild(btn);
    }
    slot.appendChild(choices);
  }

  // OCR 9: Επιστροφή στην κανονική κάμερα με post-capture auto-crop.
  // Όλες οι εικόνες και ο υπολογισμός των ορίων παραμένουν στην ίδια τη συσκευή.
  async function handlePhoto(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {toast('Επίλεξε μια φωτογραφία που υποστηρίζει η συσκευή.'); return;}
    syncDraft();
    try {
      // Το OCR ξεκινά μόνο μετά την επιβεβαίωση του πλαισίου από τον χρήστη.
      await showCardCropper(file);
    } catch (error) {
      console.error('Crop error',error);
      toast('Δεν φορτώθηκε η φωτογραφία. Δοκίμασε JPG ή PNG.');
    }
  }

  // Εντοπίζει τη μεγαλύτερη συνεχή επιφάνεια με χρώμα διαφορετικό από το
  // περιβάλλον των τεσσάρων γωνιών. Επιστρέφει null όταν δεν έχει επαρκή βεβαιότητα.
  // Κανένα λανθασμένο περίγραμμα δεν εφαρμόζεται χωρίς οπτική επιβεβαίωση.
  function detectCardRect(canvas) {
    const w=canvas.width, h=canvas.height;
    if(w<50||h<50) return null;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    const pixels=context.getImageData(0,0,w,h).data;
    const channelMedian=(values) => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const backgrounds=[[],[],[]];
    for(const u of [.025,.045,.075,.10]) for(const v of [.025,.045,.075,.10])
      for(const [xx,yy] of [[u,v],[1-u,v],[u,1-v],[1-u,1-v]]) {
        const x=Math.min(w-1,Math.floor(xx*w)),y=Math.min(h-1,Math.floor(yy*h)),idx=(y*w+x)*4;
        for(let c=0;c<3;c++) backgrounds[c].push(pixels[idx+c]);
      }
    const bg=backgrounds.map(channelMedian);
    const variations=backgrounds.map((values,i)=>{
      const distances=values.map(t=>Math.abs(t-bg[i]));
      return channelMedian(distances);
    });
    // Πολύ διαφορετικά χρώματα στις γωνίες: δεν εμπιστευόμαστε auto-crop.
    if (Math.max(...variations)>39) return null;
    const mask=new Uint8Array(w*h);
    const seen=new Uint8Array(w*h);
    for(let i=0,j=0;i<mask.length;i++,j+=4) {
      const r=pixels[j]-bg[0],g=pixels[j+1]-bg[1],b=pixels[j+2]-bg[2];
      const delta=Math.abs(.2126*r+.7152*g+.0722*b);
      const distance=r*r+g*g+b*b;
      if((distance>5400 && delta>33)||distance>17500) mask[i]=1;
    }
    let best=null, bestScore=0;
    const queue=new Int32Array(w*h);
    for(let p=0;p<mask.length;p++) {
      if(!mask[p]||seen[p])continue;
      seen[p]=1; let head=0,tail=1;queue[0]=p;
      let minX=p%w,maxX=minX,minY=Math.floor(p/w),maxY=minY;
      while(head<tail) {
        const q=queue[head++],x=q%w,y=(q-x)/w;
        if(x<minX)minX=x;if(x>maxX)maxX=x;
        if(y<minY)minY=y;if(y>maxY)maxY=y;
        if(x>0&&mask[q-1]&&!seen[q-1]){seen[q-1]=1;queue[tail++]=q-1;}
        if(x<w-1&&mask[q+1]&&!seen[q+1]){seen[q+1]=1;queue[tail++]=q+1;}
        if(y>0&&mask[q-w]&&!seen[q-w]){seen[q-w]=1;queue[tail++]=q-w;}
        if(y<h-1&&mask[q+w]&&!seen[q+w]){seen[q+w]=1;queue[tail++]=q+w;}
      }
      const bw=maxX-minX+1,bh=maxY-minY+1,ratio=bw/bh;
      const coverage=tail/(bw*bh),area=tail/(w*h);
      if(bw/w<.28||bh/h<.095||area<.035||coverage<.40||ratio<1.28||ratio>2.3) continue;
      // Κάρτα με φόντο που πιάνει όλη τη φωτογραφία: καλύτερα χειροκίνητη επιλογή.
      if(bw/w>.985&&bh/h>.985)continue;
      const score=tail*coverage;
      if(score>bestScore) {bestScore=score;best={minX,maxX,minY,maxY};}
    }
    if(!best)return null;
    // Μικρό περιθώριο ώστε να μη χαθούν γράμματα στα άκρα.
    const padX=Math.max(2,Math.round(w*.007)),padY=Math.max(2,Math.round(h*.007));
    const x1=Math.max(0,best.minX-padX),y1=Math.max(0,best.minY-padY);
    const x2=Math.min(w,best.maxX+1+padX),y2=Math.min(h,best.maxY+1+padY);
    return {x:x1/w,y:y1/h,w:(x2-x1)/w,h:(y2-y1)/h};
  }

  // Ολοκληρωμένη οθόνη περικοπής με μετακίνηση και 4 λαβές για διόρθωση.
  async function showCardCropper(file) {
    if(activeCropCleanup)activeCropCleanup();
    const url=URL.createObjectURL(file);
    let image;
    try {
      image=await new Promise((resolve,reject)=>{
        const el=new Image();el.onload=()=>resolve(el);
        el.onerror=()=>reject(new Error('Αδυναμία αποκωδικοποίησης εικόνας'));
        el.src=url;
      });
    } catch(error){URL.revokeObjectURL(url);throw error;}
    if(!image.naturalWidth||!image.naturalHeight) {URL.revokeObjectURL(url);throw new Error('Κενή εικόνα');}
    const maxEdge=560,scale=Math.min(1,maxEdge/Math.max(image.naturalWidth,image.naturalHeight));
    const sample=document.createElement('canvas');
    sample.width=Math.max(1,Math.round(image.naturalWidth*scale));
    sample.height=Math.max(1,Math.round(image.naturalHeight*scale));
    sample.getContext('2d',{alpha:false,willReadFrequently:true}).drawImage(image,0,0,sample.width,sample.height);
    const detected=detectCardRect(sample);
    // Αρχικό πλαίσιο όταν δεν έχει επιβεβαιωθεί αυτόματη αναγνώριση.
    const fallbackRect=()=>{
      const ww=.86, hh=Math.min(.68,.86*image.naturalWidth/image.naturalHeight/1.67);
      return {x:(1-ww)/2,y:(1-hh)/2,w:ww,h:hh};
    };
    let rect=detected||fallbackRect();
    const previousOverflow=document.body.style.overflow;
    const wrap=document.createElement('div');wrap.className='card-crop-overlay';
    wrap.innerHTML=`<div class="card-crop-dialog" role="dialog" aria-modal="true" aria-label="Περικοπή επαγγελματικής κάρτας">
      <div class="crop-title"><strong>Περικοπή κάρτας</strong><button type="button" class="crop-close" id="cropCancelTop" aria-label="Κλείσιμο">✕</button></div>
      <p class="crop-explainer">Κράτησε <b>μόνο την κάρτα</b> μέσα στο πράσινο πλαίσιο. Σύρε το πλαίσιο ή τις γωνίες του.</p>
      <div class="crop-stage" id="cardCropStage"><canvas id="cardCropCanvas"></canvas><div class="crop-box" id="cardCropBox" aria-label="Περιοχή περικοπής"><span class="crop-corner tl" data-corner="tl"></span><span class="crop-corner tr" data-corner="tr"></span><span class="crop-corner bl" data-corner="bl"></span><span class="crop-corner br" data-corner="br"></span></div></div>
      <p class="crop-feedback" id="cropFeedback" aria-live="polite">${detected?'Βρέθηκε πιθανό περίγραμμα. Έλεγξέ το πριν συνεχίσεις.':'Δεν βρέθηκε με σιγουριά η κάρτα. Ρύθμισε το περίγραμμα χειροκίνητα.'}</p>
      <div class="crop-tools"><button type="button" id="cropAuto" class="btn btn-outline">⌗ Αυτόματο</button><button type="button" id="cropFull" class="btn btn-outline">Ολόκληρη εικόνα</button></div>
      <div class="crop-actions"><button type="button" id="cropCancel" class="btn btn-outline">Ακύρωση</button><button type="button" id="cropConfirm" class="btn btn-primary">✓ Περικοπή & OCR</button></div>
    </div>`;
    document.body.appendChild(wrap);
    document.body.style.overflow='hidden';
    const stage=wrap.querySelector('#cardCropStage');
    const box=wrap.querySelector('#cardCropBox');
    const cv=wrap.querySelector('#cardCropCanvas');
    cv.width=sample.width;cv.height=sample.height;
    cv.getContext('2d').drawImage(sample,0,0);
    let disposed=false, busy=false;
    const draw=()=>{box.style.left=`${rect.x*100}%`;box.style.top=`${rect.y*100}%`;box.style.width=`${rect.w*100}%`;box.style.height=`${rect.h*100}%`;};
    const limit=(n,min,max)=>Math.max(min,Math.min(max,n));
    const minimum=.065;
    const feedback=wrap.querySelector('#cropFeedback');
    function pointerDown(event) {
      if(event.button!==0) return;
      event.preventDefault();
      const corner=event.target.dataset.corner||'move';
      const start={x:event.clientX,y:event.clientY};
      const original={...rect};
      box.setPointerCapture(event.pointerId);
      function move(e) {
        if(disposed)return;
        const bounds=stage.getBoundingClientRect();
        const dx=(e.clientX-start.x)/bounds.width,dy=(e.clientY-start.y)/bounds.height;
        if(corner==='move') {
          rect.x=limit(original.x+dx,0,1-original.w);
          rect.y=limit(original.y+dy,0,1-original.h);
        } else {
          const left=corner.endsWith('l'),top=corner.startsWith('t');
          const x1=left?limit(original.x+dx,0,original.x+original.w-minimum):original.x;
          const y1=top?limit(original.y+dy,0,original.y+original.h-minimum):original.y;
          const x2=!left?limit(original.x+original.w+dx,original.x+minimum,1):original.x+original.w;
          const y2=!top?limit(original.y+original.h+dy,original.y+minimum,1):original.y+original.h;
          rect={x:x1,y:y1,w:x2-x1,h:y2-y1};
        }
        draw();
      }
      const end=()=>{box.removeEventListener('pointermove',move);box.removeEventListener('pointerup',end);box.removeEventListener('pointercancel',end);};
      box.addEventListener('pointermove',move);box.addEventListener('pointerup',end);box.addEventListener('pointercancel',end);
    }
    box.addEventListener('pointerdown',pointerDown);
    const oldKey=event=>{if(event.key==='Escape')close();};
    function close() {
      if(disposed)return;
      disposed=true;
      document.removeEventListener('keydown',oldKey);
      box.removeEventListener('pointerdown',pointerDown);
      document.body.style.overflow=previousOverflow;
      URL.revokeObjectURL(url);
      wrap.remove();
      if(activeCropCleanup===close)activeCropCleanup=null;
    }
    activeCropCleanup=close;
    document.addEventListener('keydown',oldKey);
    wrap.querySelector('#cropCancelTop').onclick=close;
    wrap.querySelector('#cropCancel').onclick=close;
    wrap.querySelector('#cropAuto').onclick=()=>{
      const next=detectCardRect(sample);
      if(next){rect=next;draw();feedback.textContent='Εντοπίστηκε κάρτα. Έλεγξε τα όρια.';}
      else{feedback.textContent='Δεν εντοπίστηκε με βεβαιότητα. Μετακίνησε το πλαίσιο χειροκίνητα.';}
    };
    wrap.querySelector('#cropFull').onclick=()=>{
      rect={x:0,y:0,w:1,h:1};draw();feedback.textContent='Επιλέχθηκε ολόκληρη η φωτογραφία.';
    };
    wrap.querySelector('#cropConfirm').onclick=async()=>{
      if(busy||disposed)return;busy=true;
      const button=wrap.querySelector('#cropConfirm');button.disabled=true;
      button.textContent='Περικοπή…';
      try {
        const srcW=image.naturalWidth,srcH=image.naturalHeight;
        const sx=Math.round(rect.x*srcW),sy=Math.round(rect.y*srcH);
        const sw=Math.max(1,Math.round(rect.w*srcW)),sh=Math.max(1,Math.round(rect.h*srcH));
        const down=Math.min(1,2800/Math.max(sw,sh));
        const output=document.createElement('canvas');
        output.width=Math.max(1,Math.round(sw*down));
        output.height=Math.max(1,Math.round(sh*down));
        const ctx=output.getContext('2d',{alpha:false});
        ctx.fillStyle='#fff';ctx.fillRect(0,0,output.width,output.height);
        ctx.imageSmoothingQuality='high';
        ctx.drawImage(image,sx,sy,sw,sh,0,0,output.width,output.height);
        const blob=await new Promise((resolve,reject)=>output.toBlob(b=>b?resolve(b):reject(new Error('Αποτυχία περικοπής')),'image/jpeg',.93));
        close();
        if(!draft)return;
        draft.photoBlob=blob;
        phoneReviewCandidates=[];
        renderPhoneReview();
        releasePhotoURL();photoURL=URL.createObjectURL(blob);
        document.getElementById('photoArea').innerHTML=`<img src="${photoURL}" alt="Περικομμένη επαγγελματική κάρτα">`;
        document.getElementById('retryOCR').disabled=false;
        await processOCR();
      } catch(err) {
        console.error(err);if(!disposed){feedback.textContent='Αποτυχία περικοπής. Δοκίμασε ξανά.';button.disabled=false;button.textContent='✓ Περικοπή & OCR';}
      } finally{busy=false;}
    };
    draw();
  }

  async function downscalePhoto(file) {
    // Συμπίεση εικόνας ώστε πολλές κάρτες να χωρούν στη μνήμη του κινητού.
    const objectURL = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve,reject) => {const i = new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Αδυναμία ανάγνωσης εικόνας'));i.src=objectURL;});
      const ratio = Math.min(1, 2800/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas = document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(img.naturalHeight*ratio));
      const ctx = canvas.getContext('2d',{alpha:false}); ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      return await new Promise((resolve,reject) => canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Δεν ολοκληρώθηκε η συμπίεση')),'image/jpeg',.90));
    } finally { URL.revokeObjectURL(objectURL); }
  }
  function setOCRStatus(message,type='') {const el=document.getElementById('ocrStatus');if(!el)return;el.className=`ocr-bar ${type}`;el.innerHTML=`<div>${esc(message)}</div><button class="btn btn-outline" id="retryOCR" type="button" ${ocrRunning?'disabled':''}>↻ ${ocrRunning?'Σε εξέλιξη…':'Επανάληψη OCR'}</button>`;document.getElementById('retryOCR').onclick=()=>processOCR();}
  let tesseractPromise;
  function loadTesseract() {
    if (window.Tesseract?.createWorker) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve,reject)=>{
      const script = document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      script.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(new Error('Το OCR δεν φορτώθηκε.'));
      script.onerror=()=>reject(new Error('Απαιτείται σύνδεση στο διαδίκτυο για το OCR.'));
      document.head.appendChild(script);
    }).catch(e=>{tesseractPromise=null;throw e;});
    return tesseractPromise;
  }
  // Προετοιμασία ειδικά για OCR: διατηρούμε την κάρτα ως εικόνα αλλά
  // αναγνωρίζουμε από ξεχωριστό καμβά υψηλής ευκρίνειας/αντίθεσης.
  async function prepareOCRImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Αδυναμία ανάγνωσης εικόνας για OCR'));
        el.src = url;
      });
      // Δεν σμικρύνουμε ξανά το ήδη συμπιεσμένο πρωτότυπο.
      // Μικρότερα καρέ με λεπτά γράμματα μεγεθύνονται έως 1.5 φορές.
      const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = Math.min(1.5, Math.max(1, 2700 / longEdge));
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(3300, Math.round(img.naturalWidth * scale));
      canvas.height = Math.min(3300, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d', {alpha:false});
      if (!ctx) return blob;
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      // Η ελαφρά αύξηση αντίθεσης βελτιώνει συνήθως μικρά, ανοιχτόχρωμα γράμματα.
      ctx.filter = 'grayscale(1) contrast(1.28)';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      return await new Promise((resolve,reject) => canvas.toBlob(
        b => b?resolve(b):reject(new Error('Αποτυχία επεξεργασίας OCR')), 'image/png'
      ));
    } finally { URL.revokeObjectURL(url); }
  }

  // v4: το OCR απλώς διαβάζει χαρακτήρες· ένα δεύτερο στάδιο επιλέγει
  // προσωπικά ονόματα, όχι διευθύνσεις/εταιρείες. Σε αμφιβολία ζητά επιλογή.
  const nameNormalize = str => stripForSearch(str).replace(/\s+/g,' ').trim();
  const NAME_ADDRESS_WORDS = /(?:^|\s)(?:οδος|οδ|λεωφορος|λεωφ|λεωφ\.|διευθυνση|διευθ|ταχυδρομικος|ταχ|ταχ\.|τ\.?κ\.?|αριθμος|αρ\.|περιοχη|εδρα|οικισμος|street|avenue|address|road|postcode|zip)(?:$|\s|[.:])/i;
  const NAME_ADDRESS_PLACES = /(?:^|\s)(?:αθηνα|θεσσαλονικη|αλεξανδρουπολη|βεροια|πατρα|καβαλα|δραμα|πειραιας|σερρες|ηρακλειο|ιωαννινα|κοζανη|ελλαδα|greece|thessaloniki|athens)(?:$|\s)/i;
  const NAME_NONPERSON = /(τομεα|βορειου ελλαδ|βιοτεχνολογ|biotechnolog|biotech|systems|analytica|sales|επιστημονικ|υποστηριξ|καθηγητ|παιδιατρ|νευρολογ|αναπτυξιολογ|ομοτιμ|επικουρ|professor|neurology|pediatric|paediatric|developmental|τεχνικ|μηχανικ|συντηρησ|υπευθυν|προισταμ|πωλητ|service|engineer|sales|support|manager|εταιρει|εμπορικ|ανωνυμ|βιομηχαν|βιοτεχν|επιχειρη|ιατρικ|εξοπλισμ|μηχανημ|τεχνολογ|νοσοκομ|εργαστηρ|ανταλλακτικ|ομιλ|γραφει|προμηθει|συστημ|φυσικοθεραπε|αποκαταστασ|παθολογ|ογκολ|χειρουργ|καρδιολογ|ακτινολογ|διευθυντ|καρτεσ|καρτα|επικοινωνι|παροχ|πελατ|προιον|services|solutions|company|limited|international|information|medical|equipment|technology|hospital)/i;
  const ROLE_WORDS = /(υπευθυν|επιστημονικ|πωλησ|τομεα|καθηγητ|παιδιατρ|νευρολογ|αναπτυξιολογ|professor|neurolog|pediatric|paediatric|τεχνικ|μηχανικ|υπευθυν|πωλητ|πωλησε|διευθυντ|προισταμ|παθολογ|ογκoλογ|ογκολoγ|ογκολo|ογκολ|ιατρ|χειρουργ|καρδιολογ|ακτινολογ|βιοιατρ|service|engineer|technician|sales|manager|director|support|doctor|physician)/i;
  function looksLikeAddress(value) {
    const norm = nameNormalize(value).replace(/[,;]/g,' ');
    return /\d/.test(value) || NAME_ADDRESS_WORDS.test(norm) || NAME_ADDRESS_PLACES.test(norm);
  }
  function scoreNameCandidate(raw, index, lines) {
    let value=raw.replace(/^(?:ονοματεπ[ώω]νυμο|ονομα\s*[-/]\s*επωνυμο|name|contact|επικοινωνια)\s*[:：-]\s*/iu,'').trim();
    value=value.replace(/^[·•*-]\s*/,'').replace(/\s*[|–—]\s*$/,'').trim();
    // Οι τίτλοι Δρ./Dr. δεν είναι μέρος του ονοματεπώνυμου.
    const hasDoctorTitle=/^(?:δρ|δρς|dr|doctor)\.?\s+/iu.test(value);
    if(hasDoctorTitle) value=value.replace(/^(?:δρ|δρς|dr|doctor)\.?\s+/iu,'').trim();
    // OCR 13: Προσωπικό όνομα με επαγγελματικό τίτλο, π.χ. «Δήμητρα Κωτσαλή, DVM».
    const hadCredential=/(?:,\s*|\s+)(?:D\.?V\.?M\.?|M\.?D\.?|Ph\.?D\.?|M\.?Sc\.?|B\.?Sc\.?|M\.?B\.?A\.?|D\.?D\.?S\.?)[.,]?$/iu.test(value);
    if(hadCredential) value=value.replace(/(?:,\s*|\s+)(?:D\.?V\.?M\.?|M\.?D\.?|Ph\.?D\.?|M\.?Sc\.?|B\.?Sc\.?|M\.?B\.?A\.?|D\.?D\.?S\.?)[.,]?$/iu,'').trim();
    if (value.length < 7 || value.length > 56 || looksLikeAddress(value)) return null;
    // OCR 12: οι γραμμές ειδικοτήτων (Καθηγητής Παιδιατρικής κ.λπ.)
    // δεν είναι ποτέ προσωπικά ονόματα, ακόμη κι αν έχουν δύο λέξεις.
    if (/\b(?:καθηγητ\p{L}*|παιδιατρ\p{L}*|νευρολογ\p{L}*|αναπτυξιολογ\p{L}*|professor|neurology|pediatrics|paediatrics)\b/iu.test(nameNormalize(value))) return null;
    if (/@|www\.|https?:|\b(?:fax|tel|mobile|email)\b/i.test(value)) return null;
    const norm=nameNormalize(value);
    if (NAME_NONPERSON.test(norm) || /(?:^|\s)(?:ae|a\.?e\.?|epe|ike|ltd|inc|a\.?b\.?e\.?)(?:$|\s)/i.test(norm)) return null;
    if (/[^\p{L}\p{M}\s.'’΄-]/u.test(value)) return null;
    const words=value.split(/\s+/).filter(Boolean);
    if (words.length<2 || words.length>4) return null;
    if(words.length===2 && words.some(w=>(w.match(/\p{L}/gu)||[]).length<3)) return null;
    if (words.some(w=>!/(?:^[\p{L}\p{M}]{2,}(?:[-’'][\p{L}\p{M}]+)?$|^[\p{L}]\.$)/u.test(w))) return null;
    if (words.filter(w=>/^[\p{L}\p{M}]{2,}/u.test(w)).length<2) return null;
    const letters=(value.match(/\p{L}/gu)||[]).length;
    const greek=(value.match(/[Α-ΩΆΈΉΊΌΎΏα-ωάέήίόύώϊΐϋΰ]/g)||[]).length;
    if (letters<8 || greek/letters<.5) return null;
    let score = words.length===2 ? 5.1 : words.length===3 ? 4.6 : 3.8;
    if (hasDoctorTitle) score += 3.4;
    if (hadCredential) score += 2.7;
    // Τα τυπογραφικά λογότυπα δύο κεφαλαίων λέξεων δεν ταυτίζονται αυτόματα με άνθρωπο.
    const allUpper=value===value.toLocaleUpperCase('el-GR') && (value.match(/\p{L}/gu)||[]).length>=10;
    if(allUpper && !hasDoctorTitle && !hadCredential) score-=6.4;
    if (/^(?:[\p{L}]{3,})\s+[\p{L}]\.\s+[\p{L}]{3,}$/u.test(value)) score += 2.6; // Όνομα Α. Επώνυμο
    if (index<4) score += 2.1-index*.35;
    if (index>=7) score -= .6;
    const previous=nameNormalize(lines[index-1]||'');
    if (/(?:ονοματεπωνυμο|ονομα|name|contact person)/i.test(previous)) score+=3;
    const nearby=lines.slice(Math.max(0,index-2),Math.min(lines.length,index+3))
      .filter((_,i)=>Math.max(0,index-2)+i!==index);
    if (nearby.some(l=>ROLE_WORDS.test(nameNormalize(l)))) score+=2.1;
    if (hadCredential && nearby.some(l=>/πωλησ|υπευθυν|υποστηριξ/iu.test(nameNormalize(l))))score+=.5;
    // Διευθύνσεις που έχουν μόνο γράμματα (π.χ. Παύλου Μελά) συνήθως
    // συνοδεύονται από διεύθυνση, πόλη ή ταχυδρομικό κώδικα.
    const nearAddress=nearby.some(l=>looksLikeAddress(l) && !/^(?:69|2)\d{8}$/.test(l.replace(/\D/g,'')));
    const nearRole=nearby.some(l=>ROLE_WORDS.test(nameNormalize(l)));
    if (nearAddress && nearRole) score-=0.5;
    else if (nearAddress) score-=2.7;
    if (nearAddress && !nearRole && !/(?:ονοματεπωνυμο|ονομα|name)/i.test(previous)) score-=2;
    if (lines.slice(0,index).some(l=>/@|www\.|(?:\+?30)?(?:69\d{2}|2\d{3})[\s.-]/i.test(l))) score-=1.4;
    if (/^[Α-ΩΆΈΉΊΌΎΏ\s.'’΄-]+$/u.test(value))score+=.4;
    return {name:value,score:Math.round(score*100)/100};
  }
  function extractNameCandidates(text) {
    const lines=String(text||'').replace(/[\u200B-\u200D]/g,'').split(/[\r\n]+/)
      .map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean);
    const candidates=[];
    for(let i=0;i<lines.length;i++){
      const candidate=scoreNameCandidate(lines[i],i,lines);
      if(candidate)candidates.push(candidate);
      // Ορισμένες κάρτες τυπώνουν επώνυμο και όνομα σε δύο συνεχείς γραμμές.
      if(i<lines.length-1 && /^\p{L}{3,}$/u.test(lines[i]) && /^\p{L}{3,}$/u.test(lines[i+1])){
        const combined=scoreNameCandidate(lines[i]+' '+lines[i+1],i,lines);
        if(combined)candidates.push({...combined,score:combined.score-1.1});
      }
    }
    return candidates;
  }
  function mergeNameCandidates(...texts) {
    const byName=new Map();
    texts.forEach((text,reading)=>extractNameCandidates(text).forEach(c=>{
      const key=nameNormalize(c.name);
      const current=byName.get(key);
      if(!current)byName.set(key,{...c,readings:new Set([reading])});
      else {current.score=Math.max(current.score,c.score);current.readings.add(reading);}
    }));
    return [...byName.values()].map(c=>({name:c.name,score:c.score+(c.readings.size>1?1.1:0)}))
      .sort((a,b)=>b.score-a.score).slice(0,5);
  }
  function showNameSuggestions(candidates) {
    const target=document.getElementById('nameSuggestions');
    if(!target)return;
    target.replaceChildren();
    const likely=candidates.filter(c=>c.score>=4.5).slice(0,4);
    if(!likely.length)return;
    const help=document.createElement('div');help.className='hint';
    help.textContent='Προτάσεις ονόματος από την κάρτα — πάτησε το σωστό αν χρειάζεται διόρθωση:';
    target.appendChild(help);
    const wrap=document.createElement('div');wrap.className='name-suggestions';
    for(const candidate of likely){
      const button=document.createElement('button');button.type='button';button.className='name-suggestion';
      button.textContent=candidate.name;
      button.addEventListener('click',()=>{document.getElementById('f_name').value=candidate.name;draft.name=candidate.name;toast('Το ονοματεπώνυμο ενημερώθηκε.');});
      wrap.appendChild(button);
    }
    target.appendChild(wrap);
  }

  // OCR 11: Υποψήφιες επωνυμίες από όλο το αναγνωρισμένο κείμενο.
  // Δεν χρησιμοποιούμε αυθαίρετα το domain ως εταιρεία ούτε τις γραμμές
  // διεύθυνσης, τηλεφώνων ή ονοματεπωνύμων. Η αμφιβολία εμφανίζεται στον χρήστη.
  const COMPANY_STRONG = /(?:^|\s)(?:α\.?\s*ε\.?|αβεε|ε\.?\s*π\.?\s*ε\.?|ι\.?\s*κ\.?\s*ε\.?|ο\.?\s*ε\.?|ε\.?\s*ε\.?|ltd\.?|limited|inc\.?|gmbh|s\.?a\.?|company|εταιρεια)(?=\s|$|[.,])/i;
  const COMPANY_TERMS = /(?:medical|medic|hospital|clinic|health|healthcare|tech(?:nologies)?|systems|solutions|industr|group|engineering|equipment|electronic|diagnostic|laborator|automation|service\s+group|biomedical|μηχανηματ|συστηματ|ιατρικ|νοσοκομ|κλινικ|διαγνωστικ|βιοιατρικ|τεχνολογ|ηλεκτρονικ|εμπορικ|βιομηχαν|εξοπλισμ|εργαστηριακ|αντιπροσωπει)/i;
  // Στις κάρτες το «BIOTECHNOLOGY SYSTEMS» είναι περιγραφή της BioAnalytica, όχι όνομα εταιρείας.
  const COMPANY_TAGLINE = /^(?:biotechnology systems|biomedical systems|medical equipment|technology systems|biotechnology|medical devices|clinical solutions|engineering solutions|τεχνολογικα συστηματα)$/i;
  const COMPANY_GENERIC = /^(?:εταιρεια|company|λογοτυπο|logo|επαγγελματικη καρτα|τεχνικη υποστηριξη|τεχνικο τμημα|τμημα προμηθειων|επικοινωνια|στοιχεια επικοινωνιας|επικοινωνηστε μαζι μας|διευθυνση|website|ιστοσελιδα|email|παρατηρησεις|υπηρεσιες|προιοντα|γραφεια|office|contact|support|sales|fax|tel)$/i;
  const COMPANY_JOB = /(?:^|\s)(?:τεχνικος|μηχανικος|υπευθυνος|πωλητης|διευθυντης|παθολογος|ογκoλογος|ογκολoγος|ιατρος|secretary|technician|engineer|manager|director|doctor|physician)(?:$|\s)/i;
  // Στελέχη, ειδικότητες, ονόματα τμημάτων κ.λπ. δεν γίνονται εταιρείες
  // ακόμη και αν περιέχουν όρους όπως «κλινική» ή «νοσοκομείο».
  const COMPANY_ROLE_LINE = /(?:^|\s)(?:διευθυντ\p{L}*|προισταμ\p{L}*|υπευθυν\p{L}*|παθολογ\p{L}*|ογκολ\p{L}*|καθηγητ\p{L}*|παιδιατρ\p{L}*|νευρολογ\p{L}*|αναπτυξιολογ\p{L}*|καρδιολογ\p{L}*|χειρουργ\p{L}*|ιατρος|ιατροι|ιατρου|ιατρων|τεχνικος|μηχανικος|επιμελητ\p{L}*|επιβλεπ\p{L}*|director|manager|physician|doctor|head\s+of|chief\s+of|professor|neurologist|pediatrician|paediatrician|phd)(?:$|\s)/iu;
  const COMPANY_ORG_UNIT = /(?:^|\s)(?:τμημα|διευθυνση|γραμματεια|μονάδα|μοναδα|κλινικης|κλινικων|πανεπιστημι\p{L}*|α\.?π\.?θ\.?|department|faculty|university|ward)(?:$|\s)/iu;
  function readableCompanyLine(value) {
    const letters=(value.match(/\p{L}/gu)||[]);
    if(letters.length<4)return false;
    // Τυπικές αστοχίες OCR λογότυπων όπως «ΞΞΞΞΣ, ΕΣ».
    if(/([Α-Ωα-ωA-Za-z])\1{2,}/u.test(value))return false;
    const normalized=nameNormalize(value);
    if(/^(?:[α-ω]\s*){1,3}$/u.test(normalized))return false;
    const tokens=normalized.split(/\s+/).filter(Boolean);
    const symbolChars=(value.match(/[^\p{L}\p{N}\s.&,\-®™]/gu)||[]).length;
    if(symbolChars>Math.max(1,letters.length*.14))return false;
    const greek=(normalized.match(/[α-ω]/g)||[]).length;
    const latin=(normalized.match(/[a-z]/g)||[]).length;
    if (greek>=4 && !/[αεηιουω]/.test(normalized))return false;
    if (latin>=4 && !/[aeiouy]/.test(normalized))return false;
    if(tokens.length>1 && tokens.every(t=>t.length<=2))return false;
    return true;
  }
  function companyLineCandidate(raw, index, lines, recognizedNames=[]) {
    const explicitlyLabeled=/^(?:εταιρ[εέ]ια|επωνυμ[ιί]α|company|organization|organisation|brand)\s*[:：-]/iu.test(raw);
    const value=raw.replace(/^(?:εταιρ[εέ]ια|επωνυμ[ιί]α|company|organization|organisation|brand)\s*[:：-]\s*/iu,'').replace(/^[•·*\-\s]+/u,'').trim();
    const norm=nameNormalize(value);
    if(value.length<4 || value.length>75 || norm.length<4 || COMPANY_GENERIC.test(norm))return null;
    if(!readableCompanyLine(value))return null;
    const isRoleLine=COMPANY_ROLE_LINE.test(norm) || COMPANY_ORG_UNIT.test(norm);
    // Ακόμη και «ΔΙΕΥΘΥΝΤΗΣ Γ' ΟΓΚΟΛΟΓΙΚΗΣ ΚΛΙΝΙΚΗΣ» περιέχει λέξη
    // «κλινικής», αλλά είναι ιδιότητα, όχι επωνυμία εταιρείας.
    if(isRoleLine && !explicitlyLabeled && !COMPANY_STRONG.test(norm))return null;
    if(/(?:@|www\.|https?:|\b(?:fax|τηλ|telephone|phone|mobile|κινητο|κωδικος)\b)/i.test(norm))return null;
    if(/\d{3,}/.test(value)||looksLikeAddress(value)||!/[\p{L}]/u.test(value))return null;
    if(/[<>\\={}\[\]]/.test(value))return null;
    if(value.split(/\s+/).length>8)return null;
    const strong=COMPANY_STRONG.test(norm);
    const industry=COMPANY_TERMS.test(norm);
    if((COMPANY_JOB.test(norm)||ROLE_WORDS.test(norm))&&!strong&&!industry)return null;
    // Δύο ή τρία αγγλικά ονόματα Title Case, χωρίς ένδειξη εταιρείας,
    // μοιάζουν περισσότερο με άνθρωπο παρά με brand.
    if(!strong&&!industry&&!explicitlyLabeled&&/^(?:[A-Z][a-z]+\s+){1,2}[A-Z][a-z]+$/.test(value))return null;
    if(recognizedNames.some(n=>nameNormalize(n)===norm))return null;
    // Το «Δημήτριος Ι. Ζαφειρίου» μπορεί να έχει αναγνωριστεί μόνο
    // στο αγγλικό πέρασμα και να μην είναι στη λίστα ονομάτων.
    // Η τυπική δομή Όνομα + αρχικό + Επώνυμο δεν είναι επωνυμία εταιρείας.
    if(!strong&&!industry&&!explicitlyLabeled &&
      /^(?:[\p{L}]{3,})\s+[\p{L}]\.?\s+[\p{L}]{3,}$/u.test(value)) return null;
    if(!strong&&!industry&&!explicitlyLabeled &&
      /(?:καθηγητ|παιδιατρ|νευρολογ|αναπτυξιολογ|professor|neurolog|pediatric|paediatric|phd|md\b)/i.test(norm)) return null;
    // Προστατεύει ιδιαίτερα από ονοματεπώνυμα στον τίτλο της κάρτας.
    const asPerson=scoreNameCandidate(value,index,lines);
    if(asPerson?.score>=6.3&&!strong&&!industry&&!explicitlyLabeled)return null;
    if(/^(?:ΔΡ|DR)\.?\s+/iu.test(value))return null;
    let score=2.7;
    const followsWithTagline=!!(lines[index+1] && COMPANY_TAGLINE.test(nameNormalize(lines[index+1])));
    if(COMPANY_TAGLINE.test(norm))score-=5.5;
    if(followsWithTagline)score+=5.4;
    if(explicitlyLabeled)score+=5;
    if(strong)score+=4.7;
    if(industry)score+=3.4;
    if(index<=2)score+=2.2;
    else if(index<=5)score+=1.2;
    if(value.split(/\s+/).length<=4)score+=.7;
    const letters=(value.match(/\p{L}/gu)||[]).length;
    const capitals=(value.match(/[Α-ΩΆΈΉΊΌΎΏA-Z]/g)||[]).length;
    if(letters>=5 && capitals/letters>.74)score+=1.2;
    if(/[&®™]/.test(value))score+=.4;
    return {name:value, score:Math.round(score*100)/100, followsWithTagline};
  }
  function extractCompanyCandidates(text, recognizedNames=[]) {
    const lines=String(text||'').replace(/[\u200B-\u200D]/g,'').split(/[\r\n]+/)
      .map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean);
    const candidates=lines.map((line,index)=>companyLineCandidate(line,index,lines,recognizedNames)).filter(Boolean);
    // Στα λογότυπα η εταιρεία και το HOSPITAL/TECHNOLOGIES κ.λπ.
    // συχνά είναι δύο γειτονικές γραμμές.
    for(let i=0;i<lines.length-1;i++) {
      const first=lines[i],second=lines[i+1];
      if (/^(?:HOSPITAL|MEDICAL|TECHNOLOGIES|SYSTEMS|GROUP|HEALTHCARE|CLINIC|TECH)$/i.test(second) &&
          /^[\p{L}\p{M}][\p{L}\p{M} &'’.-]{3,35}$/u.test(first) &&
          !COMPANY_ROLE_LINE.test(nameNormalize(first)) && !COMPANY_ROLE_LINE.test(nameNormalize(second))) {
        const combined=companyLineCandidate(first+' '+second,i,lines,recognizedNames);
        if(combined)candidates.push({...combined,score:combined.score+1.4});
      }
    }
    return candidates;
  }
  function mergeCompanyCandidates(texts, recognizedNames=[]) {
    const found=new Map();
    texts.forEach((text,reading)=>extractCompanyCandidates(text,recognizedNames).forEach(c=>{
      const key=nameNormalize(c.name);
      const prev=found.get(key);
      if(prev){prev.score=Math.max(prev.score,c.score);prev.followsWithTagline ||= c.followsWithTagline;prev.readings.add(reading);}
      else found.set(key,{...c,readings:new Set([reading])});
    }));
    return [...found.values()].map(c=>({name:c.name,score:c.score+(c.readings.size>1?1.4:0)}))
      .sort((a,b)=>b.score-a.score).slice(0,5);
  }
  function showCompanySuggestions(candidates) {
    const target=document.getElementById('companySuggestions');
    if(!target)return;
    target.replaceChildren();
    const hasReliableBrand=candidates.some(c=>c.followsWithTagline && c.score>=9.5);
    const suggestions=candidates.filter(c=>c.score>=4.7 && !(hasReliableBrand && COMPANY_TAGLINE.test(nameNormalize(c.name))) && (
      c.followsWithTagline || COMPANY_STRONG.test(nameNormalize(c.name)) || COMPANY_TERMS.test(nameNormalize(c.name)) ||
      /^(?:[Α-ΩΆΈΉΊΌΎΏ]{4,}(?:\s+[Α-ΩΆΈΉΊΌΎΏ]{3,}){0,2})$/u.test(c.name)
    )).slice(0,5);
    if(!suggestions.length){
      const hint=document.createElement('div');hint.className='hint';
      hint.textContent='Δεν διαβάστηκε αξιόπιστα επωνυμία. Αν το λογότυπο είναι γραφικό, συμπλήρωσε την εταιρεία χειροκίνητα.';
      target.appendChild(hint);
      return;
    }
    const help=document.createElement('div');help.className='hint';
    help.textContent='Πιθανές εταιρείες από την κάρτα — επίλεξε τη σωστή (το OCR μπορεί να κάνει λάθη):';
    target.appendChild(help);
    const wrap=document.createElement('div');wrap.className='company-suggestions';
    for(const c of suggestions){
      const btn=document.createElement('button');btn.type='button';btn.className='company-suggestion';
      btn.textContent=c.name;
      btn.addEventListener('click',()=>{
        const field=document.getElementById('f_company');
        if(field){field.value=c.name;draft.company=c.name;toast('Η εταιρεία ενημερώθηκε.');}
      });
      wrap.appendChild(btn);
    }
    target.appendChild(wrap);
  }

  // Επιπλέον ανάγνωση ΜΟΝΟ της ζώνης λογότυπου. Η γενική OCR
  // συχνά αγνοεί μεγάλα στυλιζαρισμένα γράμματα όταν βλέπει όλη την κάρτα.
  async function prepareLogoRegion(blob) {
    const url=URL.createObjectURL(blob);
    try {
      const img=await new Promise((resolve,reject)=>{
        const el=new Image();el.onload=()=>resolve(el);
        el.onerror=()=>reject(new Error('Αδυναμία προετοιμασίας λογότυπου'));
        el.src=url;
      });
      const cropWidth=img.naturalWidth, cropHeight=Math.max(1,Math.round(img.naturalHeight*.55));
      const scale=Math.min(2.0,Math.max(1,2300/cropWidth));
      const cv=document.createElement('canvas');
      cv.width=Math.max(1,Math.round(cropWidth*scale));
      cv.height=Math.max(1,Math.round(cropHeight*scale));
      const ctx=cv.getContext('2d',{alpha:false});
      ctx.fillStyle='#fff';ctx.fillRect(0,0,cv.width,cv.height);
      ctx.filter='grayscale(1) contrast(1.35)';
      ctx.drawImage(img,0,0,cropWidth,cropHeight,0,0,cv.width,cv.height);
      return await new Promise((resolve,reject)=>cv.toBlob(b=>b?resolve(b):reject(new Error('Αποτυχία περιοχής λογότυπου')),'image/png'));
    } finally {URL.revokeObjectURL(url);}
  }

  // OCR 12: Εφεδρικό πέρασμα με αγγλικό μοντέλο στο κάτω μισό της κάρτας
  // μόνο όταν λείπει κινητό ή η διεύθυνση email είναι ύποπτη.
  async function prepareContactRegion(blob) {
    const url=URL.createObjectURL(blob);
    try {
      const img=await new Promise((resolve,reject)=>{
        const el=new Image();el.onload=()=>resolve(el);
        el.onerror=()=>reject(new Error('Αδυναμία ανάγνωσης περιοχής επικοινωνίας'));
        el.src=url;
      });
      const width=img.naturalWidth, y=Math.floor(img.naturalHeight*.44);
      const height=Math.max(1,img.naturalHeight-y);
      const scale=Math.min(2,Math.max(1,2300/Math.max(width,height)));
      const cv=document.createElement('canvas');
      cv.width=Math.max(1,Math.round(width*scale));
      cv.height=Math.max(1,Math.round(height*scale));
      const ctx=cv.getContext('2d',{alpha:false});
      ctx.fillStyle='#fff';ctx.fillRect(0,0,cv.width,cv.height);
      ctx.filter='grayscale(1) contrast(1.22)';
      ctx.drawImage(img,0,y,width,height,0,0,cv.width,cv.height);
      return await new Promise((resolve,reject)=>cv.toBlob(b=>b?resolve(b):reject(new Error('Αδυναμία προετοιμασίας επικοινωνίας')),'image/png'));
    } finally {URL.revokeObjectURL(url);}
  }
  const splitEmailAddresses = value => String(value||'').split(/\s*[/;,|]\s*/).map(v=>v.trim()).filter(Boolean);
  const emailQuality = value => {
    const email=String(value||'').trim().toLowerCase();
    if(!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email))return 0;
    const tld=email.split('.').at(-1);
    return /^(gr|com|org|net|edu|eu|gov|info|io|uk|de|fr|co|us)$/i.test(tld)?3:1;
  };

  async function processOCR() {
    if (!draft?.photoBlob || ocrRunning) return;
    syncDraft(); ocrRunning=true;
    setOCRStatus('Προετοιμασία εικόνας για καλύτερη ανάγνωση ελληνικών…');
    let worker;
    try {
      const image = await prepareOCRImage(draft.photoBlob).catch(err => {
        console.warn('OCR preprocessing fallback', err);
        return draft.photoBlob;
      });
      const Tess = await loadTesseract();
      worker = await Tess.createWorker(['ell', 'eng'], 1, {logger:m=>{
        if (m.status === 'recognizing text') setOCRStatus(`Αναγνώριση κειμένου… ${Math.round((m.progress||0)*100)}%`);
        else if (['loading language traineddata','loading tesseract core','initializing tesseract','initializing api'].includes(m.status))
          setOCRStatus('Λήψη/φόρτωση γλωσσών (την πρώτη φορά ίσως αργήσει)…');
      }});
      // Οι κάρτες δεν έχουν μία ενιαία παράγραφο: PSM 11 = διάσπαρτο κείμενο.
      await worker.setParameters({
        tessedit_pageseg_mode: Tess.PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
      setOCRStatus('1/2 · Ανάγνωση ελληνικών και λατινικών…');
      const bilingual = (await worker.recognize(image)).data?.text || '';
      const mixedParsed = parseCard(bilingual);

      // Η δεύτερη ανάγνωση με μόνο ελληνικά αποφεύγει συχνές μετατροπές
      // ελληνικών γραμμάτων σε οπτικά παρόμοια λατινικά.
      let greekText = '';
      try {
        setOCRStatus('2/2 · Βελτίωση ελληνικών ονομάτων…');
        await worker.reinitialize('ell',1);
        await worker.setParameters({
          tessedit_pageseg_mode: Tess.PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300'
        });
        greekText = (await worker.recognize(image)).data?.text || '';
      } catch (secondaryError) {
        console.warn('Greek-only OCR fallback', secondaryError);
      }
      const grParsed = parseCard(greekText);
      addPhoneReview([...(mixedParsed.uncertainPhones||[]),...(grParsed.uncertainPhones||[])]);
      const parsed = {...mixedParsed};
      let contactText='';
      if ((mixedParsed.mobiles||[]).length<2 || (mixedParsed.emails||[]).length<2) {
        try {
          setOCRStatus('Έλεγχος κινητού και email στο κάτω μέρος…');
          const contactRegion=await prepareContactRegion(draft.photoBlob);
          await worker.reinitialize('eng',1);
          await worker.setParameters({
            tessedit_pageseg_mode:Tess.PSM.SPARSE_TEXT,
            preserve_interword_spaces:'1',user_defined_dpi:'300'
          });
          contactText=(await worker.recognize(contactRegion)).data?.text||'';
          const contactParsed=parseCard(contactText);
          parsed.contactMobiles=contactParsed.mobiles||[];
          parsed.contactEmails=contactParsed.emails||[];
          parsed.contactLandlines=contactParsed.landlines||[];
          parsed.contactFaxes=contactParsed.faxes||[];
          addPhoneReview(contactParsed.uncertainPhones||[]);
        } catch(contactErr) {console.warn('Contact-region OCR fallback',contactErr);}
      }
      const nameCandidates = mergeNameCandidates(bilingual,greekText);
      // Όταν δεν υπάρχει αξιόπιστο όνομα, αφήνουμε κενό αντί να βάζουμε διεύθυνση.
      parsed.name = nameCandidates[0]?.score>=6.3 ? nameCandidates[0].name : '';
      showNameSuggestions(nameCandidates);
      let logoText='';
      let companyCandidates=mergeCompanyCandidates([bilingual,greekText],nameCandidates.map(c=>c.name));
      // Εάν δεν υπάρχει ξεκάθαρη επωνυμία, δοκιμάζουμε επιπλέον τα
      // στυλιζαρισμένα γράμματα στο επάνω τμήμα, μόνο με αγγλικό μοντέλο.
      const initialBest=companyCandidates[0];
      const initialSecond=companyCandidates[1];
      const initialClear=initialBest?.score>=9.5 &&
        (!initialSecond || initialBest.score-initialSecond.score>=1.6) &&
        (initialBest.followsWithTagline || COMPANY_STRONG.test(nameNormalize(initialBest.name)) || COMPANY_TERMS.test(nameNormalize(initialBest.name)));
      if(!initialClear){
        try {
          setOCRStatus('3/3 · Έλεγχος λογότυπου για την εταιρεία…');
          const brandRegion=await prepareLogoRegion(draft.photoBlob);
          await worker.reinitialize('eng',1);
          await worker.setParameters({
            tessedit_pageseg_mode:Tess.PSM.SPARSE_TEXT,
            preserve_interword_spaces:'1',user_defined_dpi:'300'
          });
          logoText=(await worker.recognize(brandRegion)).data?.text||'';
          companyCandidates=mergeCompanyCandidates([bilingual,greekText,logoText],nameCandidates.map(c=>c.name));
        } catch(brandErr) {console.warn('Logo OCR fallback',brandErr);}
      }
      // Επιλέγουμε εταιρεία μόνο όταν υπάρχουν πειστικές ενδείξεις,
      // ποτέ μόνο επειδή ένα τυχαίο OCR token είναι με κεφαλαία.
      const topCompany=companyCandidates[0], runnerUp=companyCandidates[1];
      const topNorm=nameNormalize(topCompany?.name||'');
      const credibleBrand=topCompany?.followsWithTagline || COMPANY_STRONG.test(topNorm)||COMPANY_TERMS.test(topNorm)||
        /^(?:metropolitan hospital)$/i.test(topNorm);
      if(topCompany && credibleBrand && topCompany.score>=9.5 &&
         (!runnerUp || topCompany.score-runnerUp.score>=1.6))
        parsed.company=topCompany.name;
      showCompanySuggestions(companyCandidates);
      if (grParsed.role && (!parsed.role || (grParsed.role.match(/[Α-Ωα-ω]/g)||[]).length > (parsed.role.match(/[Α-Ωα-ω]/g)||[]).length))
        parsed.role = grParsed.role;
      if (!parsed.company && grParsed.company) parsed.company = grParsed.company;
      // Η ίδια τηλεφωνική γραμμή μπορεί να αναγνωρίζεται με ή χωρίς ετικέτα FAX.
      // Η παρουσία σαφούς ετικέτας σε ΕΣΤΩ ΕΝΑ πέρασμα υπερισχύει οριστικά.
      const faxNumbers = new Set([...(mixedParsed.faxes||[]),...(grParsed.faxes||[]),...(parsed.contactFaxes||[])]);
      const commonPhoneFax=new Set([...(mixedParsed.sharedPhoneFax||[]),...(grParsed.sharedPhoneFax||[])]);
      const combinedPhones = [...new Set([...(mixedParsed.landlines||[]), ...(grParsed.landlines||[]),...(parsed.contactLandlines||[])])].filter(p=>!faxNumbers.has(p)||commonPhoneFax.has(p)).slice(0,6);
      parsed.phone = combinedPhones.join(' / ');
      parsed.fax = [...faxNumbers].join(' / ');
      // Πολλά κινητά/Email: ενώνουμε όλα τα τεκμηριωμένα στοιχεία από τις αναγνώσεις.
      const mobilesMerged=[...new Set([...(mixedParsed.mobiles||[]), ...(grParsed.mobiles||[]), ...(parsed.contactMobiles||[])])].filter(n=>n.startsWith('69'));
      const emailsMerged=[...new Set([...(mixedParsed.emails||[]), ...(grParsed.emails||[]), ...(parsed.contactEmails||[])])].filter(e=>emailQuality(e)>=3);
      parsed.mobile=mobilesMerged.join(' / ');
      parsed.email=emailsMerged.join(' / ');
      // Δεν χάνουμε αριθμούς με οπτικά παρόμοια γράμματα: προτάσεις για έλεγχο.
      addPhoneReview([...(mixedParsed.uncertainPhones||[]),...(grParsed.uncertainPhones||[]),...phoneHintsFromText(contactText).filter(x=>x.uncertain)]);
      if (!parsed.address && grParsed.address) parsed.address = grParsed.address;

      // Κρατάμε τις χειροκίνητες διορθώσεις. Αλλά προφανείς διευθύνσεις που
      // μπήκαν στο «Όνομα» από παλιό OCR μπορούν να αντικατασταθούν.
      if (parsed.name && (looksLikeAddress(draft.name||'') ||
        (draft.name && draft.company && nameNormalize(draft.name)===nameNormalize(draft.company)) ||
        (draft.name && draft.name===draft.name.toLocaleUpperCase('el-GR') && /\p{L}{4,}\s+\p{L}{4,}/u.test(draft.name)) ||
        /(?:καθηγητ|παιδιατρ|νευρολογ|αναπτυξιολογ|professor|neurology)/i.test(nameNormalize(draft.name||'')))) draft.name = parsed.name;
      // Παλιό OCR έβαζε ως «Εταιρεία» το domain (π.χ. Doctor-barbounis).
      // Το διορθώνουμε μόνο όταν υπάρχει σαφής εταιρεία πάνω στην κάρτα.
      if (draft.company && !COMPANY_STRONG.test(nameNormalize(draft.company)) &&
        !COMPANY_TERMS.test(nameNormalize(draft.company)) &&
        (/(?:καθηγητ|παιδιατρ|νευρολογ|professor|developmental)/i.test(nameNormalize(draft.company)) ||
         /^(?:[\p{L}]{3,})\s+[\p{L}]\.?\s+[\p{L}]{3,}$/u.test(draft.company))) draft.company='';
      if (parsed.company && draft.company && COMPANY_TAGLINE.test(nameNormalize(draft.company)) && parsed.company!==draft.company) draft.company=parsed.company;
      if (parsed.company && draft.company && draft.website) {
        const derived = draft.website.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('.')[0];
        if (nameNormalize(draft.company) === nameNormalize(derived)) draft.company = parsed.company;
      }
      for (const key of ['name','company','role','phone','mobile','fax','address','email','website'])
        if (!String(draft[key]||'').trim() && parsed[key]) draft[key]=parsed[key];
      // Σε επανάληψη OCR ενισχύουμε ΕΝΑ ήδη αναγνωρισμένο κινητό/email
      // με δεύτερο, μόνο όταν ο υπάρχων αριθμός/διεύθυνση επιβεβαιώνεται ξανά.
      const previousMobiles=phoneNumbersIn(draft.mobile).filter(n=>n.startsWith('69'));
      const extractedMobiles=phoneNumbersIn(parsed.mobile).filter(n=>n.startsWith('69'));
      if(previousMobiles.length && extractedMobiles.length>previousMobiles.length &&
         previousMobiles.every(n=>extractedMobiles.includes(n))) draft.mobile=extractedMobiles.join(' / ');
      const previousEmails=splitEmailAddresses(draft.email);
      const extractedEmails=splitEmailAddresses(parsed.email);
      if(previousEmails.length && extractedEmails.length>previousEmails.length &&
         previousEmails.every(e=>extractedEmails.includes(e.toLowerCase()))) draft.email=extractedEmails.join(' / ');
      // Επανάληψη OCR σε ήδη συμπληρωμένη κάρτα: αφαιρούμε από τα σταθερά
      // μόνο αριθμούς που ΕΠΙΒΕΒΑΙΩΘΗΚΑΝ ως fax από το τρέχον OCR.
      if(faxNumbers.size) {
        for(const number of faxNumbers)
          if(!commonPhoneFax.has(number) && phoneNumbersIn(draft.phone).includes(number)) draft.phone=removePhoneFromFixed(draft.phone,number);
        if(!String(draft.fax||'').trim()) draft.fax=parsed.fax;
      }
      draft.rawText = bilingual.trim() + (greekText.trim() ? '\n\n--- Ελληνική ανάγνωση ---\n' + greekText.trim() : '') + (contactText.trim() ? '\n\n--- Ανάγνωση στοιχείων επικοινωνίας ---\n' + contactText.trim() : '') + (logoText.trim() ? '\n\n--- Ανάγνωση λογότυπου ---\n' + logoText.trim() : '');
      applyDraftFields();
      showFaxSuggestions();
      renderPhoneReview();
      const missingNumbers=!phoneNumbersIn(draft.phone).length&&!phoneNumbersIn(draft.mobile).length&&!phoneNumbersIn(draft.fax).length;
      setOCRStatus(bilingual.trim() || greekText.trim()
        ? (missingNumbers?'Δεν συμπληρώθηκε κανένας αριθμός. Πάτησε «Επανέλεγχος μόνο τηλεφώνων» παρακάτω και έλεγξε τις προτάσεις.':
          parsed.name ? 'Η αναγνώριση ολοκληρώθηκε. Έλεγξε το όνομα, όλους τους αριθμούς και τα υπόλοιπα στοιχεία πριν αποθηκεύσεις.' : 'Δεν εντοπίστηκε με σιγουριά ονοματεπώνυμο. Επίλεξε πρόταση ή γράψ’ το χειροκίνητα. Αν είχε μείνει λάθος όνομα, σβήσ’ το πρώτα.')
        : 'Δεν βρέθηκε αναγνώσιμο κείμενο. Γέμισε το κάδρο με την κάρτα και δοκίμασε χωρίς αντανακλάσεις.',
        bilingual.trim() || greekText.trim() ? '' : 'warning');
    } catch (error) {
      console.error('OCR error', error);
      setOCRStatus('Δεν ολοκληρώθηκε το OCR. Έλεγξε το internet και δοκίμασε ξανά. Μπορείς πάντα να γράψεις τα στοιχεία χειροκίνητα.','error');
    } finally {
      if(worker)try{await worker.terminate();}catch(_){}
      ocrRunning=false;
      const btn=document.getElementById('retryOCR');if(btn){btn.disabled=false;btn.textContent='↻ Επανάληψη OCR';}
    }
  }
  function parseCard(text) {
    const result={}; const clean=text.replace(/[\u200B-\u200D]/g,'');
    const lines=clean.split(/[\r\n]+/).map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean);
    const foundEmails = [...new Set([...clean.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)].map(m=>m[0].toLowerCase()))]
      .filter(e=>emailQuality(e)>=3);
    result.emails=foundEmails;
    if(foundEmails.length)result.email=foundEmails.join(' / ');
    const site=clean.match(/(?:https?:\/\/|www\.)[a-z0-9.-]+\.(?:gr|com|eu|net|org)(?:\/[\w/.-]*)?/i);
    if(site)result.website=site[0];
    // OCR 6: Εντοπισμός της θέσης FAX σε κάθε γραμμή και όχι απλώς η
    // παρουσία της λέξης. Υποστηρίζονται ελληνικά/λατινικά «ομόγλυφα»
    // (FAX, FΑΧ, ΦΑΞ, ΦΑΧ) και αριθμός σε επόμενη γραμμή.
    const phonePattern = new RegExp(tolerantPhonePattern.source,'gu');
    const faxPattern = /(?<![\p{L}])(?:f[\s.·:\-]*[aαά][\s.·:\-]*[xχξ]|φ[\s.·:\-]*[αάa][\s.·:\-]*[ξχx]|facsimile|τηλεομοιοτυπ\p{L}*)(?![\p{L}])/giu;
    const telPattern = /(?<![\p{L}])(?:tel(?:ephone)?|phone|τηλ(?:εφων[οό])?)[.:：\s-]*(?![\p{L}])/giu;
    const landlines = [];
    const mobiles = [];
    const uncertainPhones=[];
    const faxes = [];
    const sharedPhoneFax = new Set(); // Ένδειξη T/F: κοινός αριθμός τηλεφώνου/fax
    let awaitingFax = 0;
    lines.forEach(line => {
      const phones=[...line.matchAll(phonePattern)];
      const markers=[
        ...[...line.matchAll(faxPattern)].map(m=>({index:m.index,type:'fax',end:m.index+m[0].length})),
        ...[...line.matchAll(telPattern)].map(m=>({index:m.index,type:'tel',end:m.index+m[0].length}))
      ].sort((a,b)=>a.index-b.index);
      if(!phones.length) {
        if(markers.length) {
          awaitingFax = markers.at(-1).type==='fax' ? 2 : 0;
        } else if(awaitingFax) awaitingFax--;
        return;
      }
      for(const hit of phones) {
        const value=normalizedGreekPhone(hit[0]);
        if(!value) continue;
        // Στο T/F: 2310... ο ίδιος αριθμός χρησιμοποιείται και για Fax.
        const sharedLabel=/\b(?:T\s*\/\s*F|Τ\s*\/\s*Φ)\s*[:.]?/iu.test(line.slice(0,hit.index));
        if (sharedLabel && value.startsWith('2') && !sharedPhoneFax.size) {
          sharedPhoneFax.add(value);
          if(!faxes.includes(value))faxes.push(value);
        }
        const before=markers.filter(m=>m.index<hit.index);
        const after=markers.filter(m=>m.index>hit.index);
        const lastBefore=before.at(-1);
        const closeAfter=after.find(m=>m.type==='fax' && m.index-(hit.index+hit[0].length)<7);
        const hasLaterNumber=phones.some(m=>m.index>hit.index);
        const isFax = (lastBefore?.type==='fax') ||
          (!lastBefore && !!awaitingFax) ||
          // Αφορά «2104809426 FAX», όχι παλαιότερα σταθερά στην ίδια γραμμή.
          (!hasLaterNumber && !!closeAfter && !lastBefore);
        // Μη συμπληρώνεις αυτόματα νούμερο που περιείχε λανθασμένα OCR γράμματα.
        if(/[ΟοOoΙIl|]/u.test(hit[0])) {
          uncertainPhones.push({number:value,type:isFax?'fax':value.startsWith('69')?'mobile':'phone',uncertain:true});
          continue;
        }
        if(value.startsWith('69')) {
          if(!isFax && !mobiles.includes(value)) mobiles.push(value);
        } else if(value.startsWith('2')) {
          const bucket=isFax?faxes:landlines;
          if(!bucket.includes(value))bucket.push(value);
        }
      }
      // Αν υπάρχει ένδειξη FAX χωρίς αριθμό ΜΕΤΑ την ένδειξη,
      // ο αριθμός μπορεί να βρίσκεται στην αμέσως επόμενη γραμμή.
      const lastFax=markers.filter(m=>m.type==='fax').at(-1);
      const numbersAfterFax=lastFax && phones.some(p=>p.index>lastFax.index);
      awaitingFax = lastFax && !numbersAfterFax ? 2 : 0;
    });
    // Το fax δεν παραμένει στη λίστα των σταθερών όταν υπάρχει σαφής ετικέτα.
    const filteredLandlines=landlines.filter(n=>!faxes.includes(n) || sharedPhoneFax.has(n));
    result.uncertainPhones=uncertainPhones;
    result.mobiles=mobiles;
    if(mobiles.length) result.mobile=mobiles.join(' / ');
    if(filteredLandlines.length) result.phone=filteredLandlines.join(' / ');
    if(faxes.length) result.fax=faxes.join(' / ');
    result.landlines=filteredLandlines;
    result.faxes=faxes;
    result.sharedPhoneFax=[...sharedPhoneFax];

    // Διεύθυνση: αναγνωρίζουμε ξεχωριστά οδό/αριθμό και Τ.Κ./πόλη.
    // Δεν θεωρούμε τη διεύθυνση ονοματεπώνυμο.
    const streetLine = lines.find(line => {
      if (/(?:\b(?:tel|phone|fax|mobile|www)\b|τηλ|κιν|φ[αά]ξ|@|https?:)/iu.test(line)) return false;
      if (/\b\d{5,}\b/.test(line)) return false;
      const matches = line.match(/^((?:[\p{L}\p{M}][\p{L}\p{M}.\s΄’'-]{3,}))\s+(\d{1,3}[A-Za-zΑ-Ωα-ω]?)\s*[,.;]?$/u);
      return !!matches && (matches[1].trim().split(/\s+/).length>=2 || /^(?:οδ|οδος|λεωφ|λεωφορος|εθν|αγ|αγιου|st\.?|str\.?)/iu.test(line));
    });
    const zipLine = lines.find(line =>
      /(?<!\d)\d{3}[\s-]?\d{2}(?!\d)/.test(line) &&
      /[\p{L}]/u.test(line) && !/(?:τηλ|κιν|fax|φ[αά]ξ|@)/iu.test(line));
    if (streetLine) result.address=streetLine+(zipLine && zipLine!==streetLine ? ', '+zipLine : '');
    else if (zipLine) result.address=zipLine;
    // OCR 12: Ιδιότητα, ιδίως ακαδημαϊκοί τίτλοι δίπλα στο ονοματεπώνυμο.
    const role=lines.find(l=>/(?:^|[^\p{L}])(υπε[υύ]θυν[\p{L}]*|πωλησ[\p{L}]*|καθηγητ[ηή]ς|καθηγητρια|παιδιατρ[οό]ς|τεχνικ[οό]ς|τεχνικ[ηή]|μηχανικ[οό]ς|πωλητ[ηή]ς|υπε[υύ]θυνος|παθολ[οό]γος|ογκολ[οό]γος|ιατρ[οό]ς|διευθυντ[ηή]ς|service|engineer|technician|doctor|physician|professor)(?=$|[^\p{L}])/iu.test(l));
    if(role) {
      const i=lines.indexOf(role);
      const next=lines[i+1]||'';
      if(/υπε[υύ]θυν/iu.test(role) && /τομ[εέ]ας|βορ[εέ]ιου\s+ελλ[αά]δος/iu.test(next) && !looksLikeAddress(next))
        result.role=role+', '+next;
      else if(/καθηγητ/iu.test(role) && /(?:νευρολογ|αναπτυξιολογ|α\.?π\.?θ\.?)/iu.test(next) && !looksLikeAddress(next))
        result.role=role+', '+next;
      else result.role = /παθολ[οό]γος/iu.test(role) && /ογκολ[οό]γος/iu.test(next)
        ? 'Παθολόγος – Ογκολόγος' : role;
    }
    // Το τελικό όνομα προκύπτει από ελεγμένες υποψηφιότητες και τις δύο
    // αναγνώσεις OCR στο processOCR — όχι από την πρώτη δίλεξη γραμμή.
    // Η διεύθυνση ιστοσελίδας δεν ταυτίζεται πάντα με την εταιρεία.
    // Προτιμάμε σαφές όνομα από το λογότυπο/κείμενο της επαγγελματικής κάρτας.
    // Παλαιότερη αναγνώριση ειδικών επωνυμιών διατηρείται ως εφεδρεία.
    // Η τελική επιλογή γίνεται από score/προτάσεις του OCR 10.
    if (lines.some(l=>/\bMETROPOLITAN\b/i.test(l))) result.company='Metropolitan Hospital';
    return result;
  }
  async function saveForm() {
    if(ocrRunning){toast('Περίμενε να ολοκληρωθεί η αναγνώριση.');return;}
    syncDraft();const error=document.getElementById('formError');error.textContent='';
    if(!draft.name.trim() && !draft.company.trim()){error.textContent='Συμπλήρωσε τουλάχιστον ονοματεπώνυμο ή εταιρεία.';document.getElementById('f_name').focus();return;}
    if(draft.email.trim() && (!splitEmailAddresses(draft.email).length || splitEmailAddresses(draft.email).some(e=>emailQuality(e)<1) || /@/.test(draft.email.replace(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi,'')))){error.textContent='Έλεγξε τη μορφή των email (χώρισέ τα με / ή ;).';return;}
    draft.assignments=dataArray(draft.assignments).map(a=>({department:a.department.trim(),equipment:a.equipment.trim()})).filter(a=>a.department||a.equipment);
    draft.id=draft.id||nextId();draft.createdAt=draft.createdAt||new Date().toISOString();draft.updatedAt=new Date().toISOString();
    const btn=document.getElementById('saveCard');btn.disabled=true;
    try {await putContact(draft);toast('Η κάρτα αποθηκεύτηκε στη συσκευή.');await showList();}
    catch(e){console.error(e);error.textContent='Δεν μπόρεσε να αποθηκευτεί. Ίσως ο χώρος αποθήκευσης του κινητού είναι γεμάτος.';btn.disabled=false;}
  }
  async function showSettings() {
    releasePhotoURL();releaseListURLs();draft=null;editingId=null;navActive('settings');
    const contacts=await allContacts();
    main.innerHTML=`<div class="page-head"><button class="back-btn" id="backList" type="button" aria-label="Επιστροφή">‹</button><div><h1 class="page-title">Αρχείο & αντίγραφα</h1><div class="sub">${contacts.length} αποθηκευμένες κάρτες</div></div></div>
      <div class="settings-option"><h3>📄 Εξαγωγή για Excel (CSV)</h3><p>Όλα τα στοιχεία επικοινωνίας, οι παρατηρήσεις και ένα ζεύγος τμήμα/μηχάνημα ανά γραμμή. Οι φωτογραφίες δεν περιλαμβάνονται στο CSV.</p><button class="btn btn-primary" id="exportCSV">Λήψη CSV για Excel</button></div>
      <div class="settings-option"><h3>🗃 Πλήρες αντίγραφο ασφαλείας (JSON)</h3><p>Αποθήκευσε τις κάρτες μαζί με τις φωτογραφίες. Φύλαξέ το σε ασφαλές σημείο, για να μη χαθούν αν καθαρίσεις τα δεδομένα του browser ή αλλάξεις συσκευή.</p><div class="btn-row"><button class="btn btn-outline" id="exportJSON">Λήψη backup</button><button class="btn btn-outline" id="importJSON">Επαναφορά backup</button></div><input class="file-input" type="file" accept=".json,application/json" id="backupInput"></div>
      <div class="settings-option"><h3>📲 Εγκατάσταση στο κινητό</h3><p>Αφού ανοίξεις την εφαρμογή από ασφαλή διεύθυνση HTTPS, στο Chrome Android επίλεξε «Εγκατάσταση εφαρμογής» ή «Προσθήκη στην αρχική οθόνη» από το μενού ⋮.</p><button class="btn btn-outline" id="installPWA">Προσπάθεια εγκατάστασης</button><div class="hint" id="installHelp"></div></div>
      <div class="notice"><strong>Ιδιωτικότητα & λειτουργία</strong>Τα στοιχεία και οι εικόνες αποθηκεύονται μόνο σε αυτόν τον browser, όχι σε νοσοκομειακό server. Το OCR τρέχει τοπικά στη συσκευή, αλλά χρειάζεται internet για τη λήψη της βιβλιοθήκης και των γλωσσικών μοντέλων. Για κοινή χρήση από πολλούς τεχνικούς χρειάζεται ξεχωριστός σχεδιασμός με εξουσιοδοτημένη πρόσβαση και αντίγραφα ασφαλείας.</div>`;
    document.getElementById('backList').onclick=()=>showList();
    document.getElementById('exportCSV').onclick=()=>exportCSV(contacts);
    document.getElementById('exportJSON').onclick=()=>exportJSON(contacts);
    document.getElementById('importJSON').onclick=()=>document.getElementById('backupInput').click();
    document.getElementById('backupInput').onchange=e=>importJSON(e.target.files[0]);
    document.getElementById('installPWA').onclick=async()=>{if(window.deferredInstallPrompt){window.deferredInstallPrompt.prompt();await window.deferredInstallPrompt.userChoice;window.deferredInstallPrompt=null;}else document.getElementById('installHelp').textContent='Άνοιξε το μενού ⋮ του Chrome και επίλεξε «Προσθήκη στην αρχική οθόνη». Λειτουργεί σε HTTPS, όχι ανοίγοντας το αρχείο HTML.';};
    window.scrollTo({top:0,behavior:'instant'});
  }
  function downloadBlob(blob,name) {const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  const exportStamp = () => new Date().toISOString().slice(0,10);
  function exportCSV(contacts) {
    const cols=['Ονοματεπώνυμο','Εταιρεία','Ιδιότητα','Σταθερά τηλέφωνα','Κινητό','Fax','Διεύθυνση','Email','Ιστοσελίδα','Τμήμα','Μηχάνημα','Παρατηρήσεις','Ημ/νία ενημέρωσης'];
    const csvSafe = value=> {let s=String(value??'');if (/^[\s]*[=+\-@\t\r]/.test(s)) s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    const rows=[cols,...contacts.flatMap(c=>(dataArray(c.assignments).length?c.assignments:[{department:'',equipment:''}]).map(a=>[c.name,c.company,c.role,c.phone,c.mobile,c.fax||'',c.address||'',c.email,c.website,a.department,a.equipment,c.notes,fmtDate(c.updatedAt)]))];
    downloadBlob(new Blob(['\ufeff',rows.map(r=>r.map(csvSafe).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}),`GN_Verias_Kartes_${exportStamp()}.csv`);
    toast('Το CSV αποθηκεύτηκε.');
  }
  const blobToDataURL = blob => new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
  async function dataURLToBlob(dataUrl) {const resp=await fetch(dataUrl);return await resp.blob();}
  async function exportJSON(contacts) {
    try {
      const results=[];
      for(const c of contacts)results.push({...c,photoBlob:undefined,photoData:c.photoBlob instanceof Blob?await blobToDataURL(c.photoBlob):null});
      downloadBlob(new Blob([JSON.stringify({application:'GN-Verias-VisitCards',version:1,exportedAt:new Date().toISOString(),contacts:results},null,2)],{type:'application/json;charset=utf-8'}),`GN_Verias_Backup_${exportStamp()}.json`);
      toast('Το πλήρες αντίγραφο ασφαλείας δημιουργήθηκε.');
    }catch(e){console.error(e);toast('Αποτυχία δημιουργίας backup.');}
  }
  async function importJSON(file) {
    if(!file)return;
    try {
      if(file.size>120*1024*1024)throw new Error('Το αρχείο είναι πολύ μεγάλο.');
      const parsed=JSON.parse(await file.text());
      if(parsed.application!=='GN-Verias-VisitCards'||!Array.isArray(parsed.contacts))throw new Error('Δεν είναι έγκυρο backup της εφαρμογής.');
      if(!confirm(`Να εισαχθούν ${parsed.contacts.length} κάρτες; Αν υπάρχει η ίδια κάρτα, θα ενημερωθεί.`))return;
      let count=0;
      for(const c of parsed.contacts){
        if(!c||typeof c!=='object')continue;
        const photoBlob=typeof c.photoData==='string'&&c.photoData.startsWith('data:image/')?await dataURLToBlob(c.photoData):null;
        const card={id:String(c.id||nextId()),name:String(c.name||''),company:String(c.company||''),role:String(c.role||''),phone:String(c.phone||''),mobile:String(c.mobile||''),fax:String(c.fax||''),address:String(c.address||''),email:String(c.email||''),website:String(c.website||''),assignments:dataArray(c.assignments).map(a=>({department:String(a.department||''),equipment:String(a.equipment||'')})),notes:String(c.notes||''),rawText:String(c.rawText||''),photoBlob,createdAt:c.createdAt||new Date().toISOString(),updatedAt:c.updatedAt||new Date().toISOString()};
        await putContact(card);count++;
      }
      toast(`Εισήχθησαν ${count} κάρτες.`);await showList();
    }catch(e){console.error(e);toast('Αδυναμία εισαγωγής: μη έγκυρο ή πολύ μεγάλο αρχείο.');}
  }
  async function init() {
    try {
      if(!('indexedDB' in window))throw new Error('Ο browser δεν υποστηρίζει IndexedDB.');
      db=await openDB();await showList();
      document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.view==='list')showList();if(button.dataset.view==='new')showForm();if(button.dataset.view==='settings')showSettings();}));
      document.getElementById('headerSettings').onclick=showSettings;
      window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();window.deferredInstallPrompt=event;});
      if('serviceWorker' in navigator && ['https:','http:'].includes(location.protocol))window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('SW',e)));
    } catch(error) { console.error(error);main.innerHTML='<div class="empty-state"><h3>Δεν είναι διαθέσιμη η τοπική αποθήκευση</h3><p>Χρησιμοποίησε Chrome σε κανονική καρτέλα και βεβαιώσου ότι δεν έχει αποκλειστεί η αποθήκευση δεδομένων για αυτήν τη σελίδα.</p></div>'; }
  }
  init();
})();
