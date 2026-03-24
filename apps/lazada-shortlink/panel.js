let isAgentRunning = false;

(async function init() {
    const cfg = await window.api.getConfig();
    document.getElementById('workerUrl').value = cfg.workerUrl || '';
    document.getElementById('autoAgent').checked = !!cfg.autoAgent;
})();

window.api.onAgentStatus((running) => {
    isAgentRunning = running;
    const el = document.getElementById('agentStatus');
    const btn = document.getElementById('btnStartAgent');
    if (running) {
        el.textContent = 'Running';
        el.className = 'agent-status running';
        btn.textContent = 'Stop Agent';
    } else {
        el.textContent = 'Stopped';
        el.className = 'agent-status stopped';
        btn.textContent = 'Start Agent';
    }
});

window.api.onLogEntry((entry) => {
    const logs = document.getElementById('logs');
    const line = document.createElement('div');
    line.className = entry.cls || '';
    const time = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `[${time}] ${entry.msg}`;
    logs.appendChild(line);
    logs.scrollTop = logs.scrollHeight;
    // Keep max 200 lines
    while (logs.children.length > 200) logs.removeChild(logs.firstChild);
});

async function onShorten() {
    const urlInput = document.getElementById('urlInput');
    const productUrl = urlInput.value.trim();
    if (!productUrl) return;

    const btn = document.getElementById('btnShorten');
    const status = document.getElementById('statusMsg');
    btn.disabled = true;
    status.textContent = 'กำลังย่อลิงก์...';
    status.className = 'status loading';

    try {
        const result = await window.api.shorten({ productUrl });
        document.getElementById('resultLink').value = result.shortLink;
        document.getElementById('resultBox').classList.remove('hidden');
        status.textContent = 'สำเร็จ!';
        status.className = 'status ok';
        // Auto-copy
        navigator.clipboard.writeText(result.shortLink).catch(() => {});
    } catch (err) {
        status.textContent = err.message || 'ผิดพลาด';
        status.className = 'status err';
    } finally {
        btn.disabled = false;
    }
}

function onClear() {
    document.getElementById('urlInput').value = '';
    document.getElementById('resultBox').classList.add('hidden');
    document.getElementById('resultLink').value = '';
    document.getElementById('statusMsg').textContent = '';
}

function onCopy() {
    const link = document.getElementById('resultLink').value;
    if (link) navigator.clipboard.writeText(link).catch(() => {});
}

async function toggleAgent() {
    await saveConfig();
    if (isAgentRunning) {
        await window.api.stopAgent();
    } else {
        await window.api.startAgent();
    }
}

async function saveConfig() {
    const workerUrl = document.getElementById('workerUrl').value.trim();
    const autoAgent = document.getElementById('autoAgent').checked;
    await window.api.saveConfig({ workerUrl, autoAgent });
}
