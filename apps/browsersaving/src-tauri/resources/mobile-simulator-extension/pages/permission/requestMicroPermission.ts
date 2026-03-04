// Using navigator.mediaDevices.getUserMedia to request microphone access
navigator.mediaDevices
.getUserMedia({ 
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    }, video: false })
.then(async (stream) => {

    console.log(await navigator.mediaDevices.enumerateDevices());
    
    // Stop the tracks to prevent the recording indicator from being shown
    document.querySelector('#slider-wrapper').style.display = 'block';
    const slider = document.querySelector('#slider-wrapper div');

    // 2. Créer le contexte audio
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);

    // 3. Créer un AnalyserNode
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256; // petite taille suffisante pour le volume
    source.connect(analyser);

    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);

    // 4. Boucle d'animation pour mettre à jour le slider
    function update() {
      analyser.getByteTimeDomainData(dataArray);

      // Calcul d'un RMS (énergie du signal)
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = (dataArray[i] - 128) / 128; // normalisé entre -1 et 1
        sum += v * v;
      }
      const rms = Math.sqrt(sum / bufferLength); // entre 0 et ~1

      // On amplifie un peu et on limite à 1
      const level = Math.min(1, rms * 5);

      // Mapping vers 0–100 pour le slider
      slider.style.width = Math.round(level * 100) + '%';

      requestAnimationFrame(update);
    }
    update();

    window.parent.postMessage({
        action: 'mf-permission_iframe_message',
        message: 'permission_granted',
        type: 'microphone'
    }, '*');
}).catch((error) => {
    window.parent.postMessage({
        action: 'mf-permission_iframe_message',
        message: 'permission_denied',
        error: error.toString(),
        type: 'microphone'
    }, '*');
});