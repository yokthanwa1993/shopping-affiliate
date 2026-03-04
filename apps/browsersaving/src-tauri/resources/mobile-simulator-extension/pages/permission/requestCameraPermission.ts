
// Using navigator.mediaDevices.getUserMedia to request microphone access
navigator.mediaDevices
.getUserMedia({ 
    audio: false, video: { facingMode: "user", width: 600, height: 600, frameRate: 30 } })
.then((media_stream) => {
    window.parent.postMessage({
        action: 'mf-permission_iframe_message',
        message: 'permission_granted',
        type: 'camera'
    }, '*');

    let video = document.getElementById('video');
    video.srcObject = media_stream;
    video.play();

}).catch((error) => {
    window.parent.postMessage({
        action: 'mf-permission_iframe_message',
        message: 'permission_denied',
        error: error.toString(),    
        type: 'camera'
    }, '*');
});