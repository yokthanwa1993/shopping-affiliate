const botToken = process.env.BOT_TOKEN;
const chatId = Number(process.env.CHAT_ID || 0);
const workerUrl = process.env.WORKER_URL || "https://video-affiliate-worker.onlyy-gor.workers.dev";

if (!botToken || !chatId) {
    throw new Error("Set BOT_TOKEN and CHAT_ID before running this script");
}

fetch(`${workerUrl}/api/telegram/${botToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        update_id: Date.now(),
        message: {
            message_id: Date.now(),
            chat: { id: chatId },
            video: { file_id: "fake_file_id" },
            text: ""
        }
    })
}).then(r => r.text()).then(console.log).catch(console.error);
