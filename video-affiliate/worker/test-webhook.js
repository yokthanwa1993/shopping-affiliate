const botToken = "8328894625:AAEgMQwFeBkTLTYP-s5feVUsc7B64jTInAs";
const chatId = 1344057381;

fetch('https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev/api/telegram', {
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
