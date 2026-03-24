(async function () {
    const params = new URLSearchParams(window.location.search);
    const account = params.get('account') || 'default';

    const els = {
        accountBadge: document.getElementById('accountBadge'),
        accountName: document.getElementById('accountName'),
        agentStatus: document.getElementById('agentStatus'),
        sessionStatus: document.getElementById('sessionStatus'),
        sessionMeta: document.getElementById('sessionMeta'),
        workerUrl: document.getElementById('workerUrl'),
        openLogin: document.getElementById('openLogin'),
        startAgent: document.getElementById('startAgent'),
        stopAgent: document.getElementById('stopAgent'),
        refreshStatus: document.getElementById('refreshStatus'),
        log: document.getElementById('log'),
    };

    function appendLog(entry) {
        const line = document.createElement('div');
        line.className = `entry ${entry.cls || 'info'}`;
        const prefix = entry.account ? `[${entry.account}] ` : '';
        line.textContent = prefix + (entry.msg || '');
        els.log.prepend(line);
    }

    function renderAgentStatus(running) {
        els.agentStatus.textContent = running ? 'Running' : 'Stopped';
    }

    function renderSessionStatus(status) {
        if (!status) {
            els.sessionStatus.textContent = 'Unknown';
            els.sessionMeta.textContent = '-';
            return;
        }

        els.sessionStatus.textContent = status.loggedIn ? 'Logged In' : 'Not Logged In';
        els.sessionMeta.textContent = `cookies=${status.cookieCount} token=${status.tokenPreview || '-'}`;
    }

    async function refresh() {
        const cfg = await window.api.getConfig();
        els.accountBadge.textContent = `account: ${account}`;
        els.accountName.textContent = account;
        els.workerUrl.textContent = cfg.workerUrl || '-';
        renderAgentStatus(await window.api.getAgentStatus());
        renderSessionStatus(await window.api.getSessionStatus(account));
    }

    els.openLogin.addEventListener('click', async () => {
        await window.api.openLogin(account);
    });

    els.startAgent.addEventListener('click', async () => {
        await window.api.startAgent();
        await refresh();
    });

    els.stopAgent.addEventListener('click', async () => {
        await window.api.stopAgent();
        await refresh();
    });

    els.refreshStatus.addEventListener('click', refresh);

    window.api.onAgentStatus((running) => {
        renderAgentStatus(running);
    });

    window.api.onSessionStatus((status) => {
        renderSessionStatus(status);
    });

    window.api.onLogEntry((entry) => {
        appendLog(entry);
    });

    await refresh();
})();
