let abortController = null;
let canvas = null;
let ctx = null;

self.onmessage = async (event) => {
    const { action } = event.data;
    try {
        if (action === 'start') await startProcessing(event.data);
    } catch(error) {
        self.postMessage({ 
            type: 'error', 
            error: {
                message: 'global error | ' + (error.message || String(error)),
                stack: error.stack,
                name: error.name
            }
        });
    }
    if(action === 'stop') stopProcessing();
};

async function startProcessing(data) {
    const { 
        videoReadable, // Entrée (depuis le tab)
        videoWritable, // Sortie (vers le Generator du main thread)
        coordinates, 
        device_image,
        orientation,
        transparent_background
    } = data;

    abortController = new AbortController();

    // Scale permet de redimmensionner si besoin
    let scale = 1;
    const outputWidth = coordinates.width * scale;
    const outputHeight = coordinates.height * scale;

    if(transparent_background) {
        canvas = new OffscreenCanvas(outputWidth, outputHeight);
        ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
        ctx.imageSmoothingQuality = 'high';
    }

    // --- Transformer ---
    const transformer = new TransformStream({
        async transform(videoFrame, controller) {
            try {
                let newFrame;
                if(transparent_background) {

                    // Dessiner la frame vidéo
                    ctx.drawImage(videoFrame, 
                        coordinates.left, coordinates.top, coordinates.width, coordinates.height, 
                        0, 0, outputWidth, outputHeight
                    );
                    // On ajoute le device comme masque
                    ctx.globalCompositeOperation = 'destination-in';

                    if(orientation === 'landscape') {
                        ctx.save();
                        ctx.rotate(-Math.PI / 2);
                        ctx.translate(- (outputHeight), 0);
                        ctx.drawImage(device_image, 0, 0, outputHeight, outputWidth);
                        ctx.restore();
                    } else {
                        ctx.drawImage(device_image, 0, 0, outputWidth, outputHeight);
                    }
                    ctx.globalCompositeOperation = 'source-over';

                    newFrame = new VideoFrame(canvas, { timestamp: videoFrame.timestamp });

                } else {
                    newFrame = new VideoFrame(videoFrame, {
                        visibleRect: {
                            x: makeEven(coordinates.left, false), y: makeEven(coordinates.top, false),
                            width: coordinates.width, height: coordinates.height
                        }
                    });
                }
                videoFrame.close();
                controller.enqueue(newFrame);

            } catch (err) {
                videoFrame.close();
                self.postMessage({ 
                    type: 'error', 
                    error: {
                        message: 'transform stream | ' + err.message || String(err),
                        stack: err.stack,
                        name: err.name
                    }
                });
            }
        }
    });

    // --- Le Pipeline ---
    videoReadable
        .pipeThrough(transformer, { signal: abortController.signal })
        .pipeTo(videoWritable, { signal: abortController.signal });
}

function stopProcessing() {
    if (abortController) abortController.abort();
}

function makeEven(nombre, nePasDepasser) {
    if (nePasDepasser) {
        let entier = Math.floor(nombre);
        return (entier % 2 === 0) ? entier : entier - 1;
    } else {
        let entier = Math.ceil(nombre);
        return (entier % 2 === 0) ? entier : entier + 1;
    }
}