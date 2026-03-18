const $ = (s) => document.querySelector(s);

const els = {
    form: $('#form'),
    url: $('#product-url'),
    sub1: $('#sub1'),
    sub2: $('#sub2'),
    sub3: $('#sub3'),
    sub4: $('#sub4'),
    sub5: $('#sub5'),
    btnShorten: $('#btn-shorten'),
    btnClear: $('#btn-clear'),
    btnCopy: $('#btn-copy'),
    btnShopee: $('#btn-shopee'),
    btnAgentToggle: $('#btn-agent-toggle'),
    status: $('#status'),
    result: $('#result'),
    shortLink: $('#short-link'),
    iconCopy: $('#icon-copy'),
    iconCheck: $('#icon-check'),
    agentSection: $('#agent-section'),
    agentDot: $('#agent-dot'),
    agentStatusText: $('#agent-status-text'),
    btnAgentStart: $('#btn-agent-start'),
    btnAgentStop: $('#btn-agent-stop'),
    workerUrl: $('#worker-url'),
    btnSaveConfig: $('#btn-save-config'),
    agentLog: $('#agent-log'),
};

// --- Init ---
els.form.addEventListener('submit', onShorten);
els.btnClear.addEventListener('click', onClear);
els.btnCopy.addEventListener('click', onCopy);
els.btnShopee.addEventListener('click', () => window.api.toggleShopee());
els.btnAgentToggle.addEventListener('click', toggleAgentSection);
els.btnAgentStart.addEventListener('click', onAgentStart);
els.btnAgentStop.addEventListener('click', onAgentStop);
els.btnSaveConfig.addEventListener('click', onSaveConfig);

// Load config
window.api.getConfig().then((cfg) => {
    els.workerUrl.value = cfg.workerUrl || '';
});

window.api.getAgentStatus().then((running) => {
    updateAgentUI(running);
});

// Agent events from main process
window.api.onAgentStatus((running) => updateAgentUI(running));
window.api.onAgentLog(({ msg, cls }) => addLog(msg, cls));

// --- Shorten ---
async function onShorten(e) {
    e.preventDefault();
    setBusy(true);
    showStatus('กำลังย่อลิงก์...', '');
    hideResult();

    try {
        const resp = await window.api.shorten({
            productUrl: els.url.value.trim(),
            subId1: els.sub1.value.trim(),
            subId2: els.sub2.value.trim(),
            subId3: els.sub3.value.trim(),
            subId4: els.sub4.value.trim(),
            subId5: els.sub5.value.trim(),
        });

        showResult(resp.shortLink);
        await navigator.clipboard.writeText(resp.shortLink);
        showStatus('Copied!', 'success');
    } catch (err) {
        showStatus(err.message, 'error');
    } finally {
        setBusy(false);
    }
}

// --- Clear ---
function onClear() {
    els.url.value = '';
    els.sub1.value = '';
    els.sub2.value = '';
    els.sub3.value = '';
    els.sub4.value = '';
    els.sub5.value = '';
    hideResult();
    hideStatus();
    els.url.focus();
}

// --- Copy ---
async function onCopy() {
    const link = els.shortLink.value;
    if (!link) return;
    await navigator.clipboard.writeText(link);
    els.iconCopy.classList.add('hide');
    els.iconCheck.classList.remove('hide');
    setTimeout(() => {
        els.iconCheck.classList.add('hide');
        els.iconCopy.classList.remove('hide');
    }, 2000);
}

// --- Agent ---
function toggleAgentSection() {
    els.agentSection.classList.toggle('hide');
}

async function onAgentStart() {
    await onSaveConfig();
    await window.api.startAgent();
}

async function onAgentStop() {
    await window.api.stopAgent();
}

async function onSaveConfig() {
    await window.api.saveConfig({
        workerUrl: els.workerUrl.value.trim(),
    });
}

function updateAgentUI(running) {
    els.agentDot.className = 'dot ' + (running ? 'green' : '');
    els.agentStatusText.textContent = running ? 'Running' : 'Stopped';
    els.btnAgentStart.disabled = running;
    els.btnAgentStop.disabled = !running;
}

function addLog(msg, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${msg}`;
    els.agentLog.prepend(div);
    while (els.agentLog.children.length > 100) {
        els.agentLog.removeChild(els.agentLog.lastChild);
    }
}

// --- Helpers ---
function setBusy(busy) {
    els.btnShorten.disabled = busy;
    els.btnClear.disabled = busy;
}

function showStatus(msg, variant) {
    els.status.textContent = msg;
    els.status.classList.remove('hide');
    if (variant) {
        els.status.dataset.v = variant;
    } else {
        delete els.status.dataset.v;
    }
}

function hideStatus() {
    els.status.classList.add('hide');
    els.status.textContent = '';
    delete els.status.dataset.v;
}

function showResult(link) {
    els.shortLink.value = link;
    els.result.classList.remove('hide');
}

function hideResult() {
    els.shortLink.value = '';
    els.result.classList.add('hide');
}
