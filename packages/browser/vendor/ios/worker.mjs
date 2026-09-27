// Same-family BiRefNet-lite experiment. All pixels stay in this browser.
// A worker prevents blocking the UI; it does NOT bypass the tab memory limit.
const runtimeUrl = new URL('./ort.wasm.min.mjs', import.meta.url).href;
// Must match manifest.json. The host serves the model compressed without a
// Content-Length, so the known size lets the download fill one exact buffer
// instead of growing copies, and each chunk tells the page's watchdog that
// the download is still moving.
const MODEL_BYTES = 55563408;
let ort;
let session;
let size;
let busy = false;
async function downloadModel(response) {
  if (!response.body?.getReader) return new Uint8Array(await response.arrayBuffer());
  const bytes = new Uint8Array(MODEL_BYTES);
  const reader = response.body.getReader();
  let offset = 0;
  let reported = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (offset + value.byteLength > MODEL_BYTES) throw new Error('Unexpected model size');
    bytes.set(value, offset);
    offset += value.byteLength;
    if (offset - reported >= MODEL_BYTES / 50) {
      reported = offset;
      self.postMessage({stage:'loading', progress: offset / MODEL_BYTES});
    }
  }
  if (offset !== MODEL_BYTES) throw new Error('Unexpected model size');
  return bytes;
}
// Report allocation failures by category so the page can explain them.
function failure(type, error) {
  const text = `${error?.name ?? ''} ${error?.message ?? error ?? ''}`.toLowerCase();
  if (error instanceof RangeError || /memory|alloc|\boom\b/.test(text)) return 'out-of-memory';
  return type === 'load' ? 'model-load-failed' : 'inference-failed';
}
self.onmessage = async ({data}) => {
  const {id,type} = data;
  if (busy) { self.postMessage({id,error:'Already processing'}); return; }
  busy = true;
  let input;
  let outputs;
  try {
    if (type === 'load') {
ort = await import(/* @vite-ignore */ runtimeUrl);

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = {
  mjs: new URL('./ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('./ort-wasm-simd-threaded.wasm', import.meta.url).href,
};

      if (session) throw new Error('Model already loaded');
      size = 512;
      self.postMessage({stage:'loading'});
      const response = await fetch(new URL('./int8-full-512.ort',import.meta.url));
      if (!response.ok) throw new Error('Model download failed');
      let bytes = await downloadModel(response);
      self.postMessage({stage:'starting'});
      session = await ort.InferenceSession.create(bytes, {
        executionProviders:['wasm'], executionMode:'sequential',
        graphOptimizationLevel:'disabled', enableCpuMemArena:false, enableMemPattern:false,
        // The Web WASM binding frees the input model buffer after create().
        // Never enable initializer pointers into that freed buffer.
        extra:{session:{use_ort_model_bytes_directly:'1',use_ort_model_bytes_for_initializers:'0'}},
      });
      bytes = undefined;
      self.postMessage({id,ready:true});
    } else if (type === 'run') {
      if (!session || data.buffer.byteLength !== size * size * 3 * 4) throw new Error('Invalid input');
      input = new ort.Tensor('float32',new Float32Array(data.buffer),[1,3,size,size]);
      outputs = await session.run({[session.inputNames[0]]:input},[session.outputNames[0]]);
      const values=outputs[session.outputNames[0]].data;
      if(values.length!==size*size) throw new Error('Unexpected mask');
      const alpha=new Float32Array(values.length);
      for(let i=0;i<values.length;i++) {
        if(!Number.isFinite(values[i])) throw new Error('Invalid mask');
        alpha[i]=1/(1+Math.exp(-values[i]));
      }
      self.postMessage({id,alpha:alpha.buffer},[alpha.buffer]);
    } else throw new Error('Unknown action');
  } catch(error) {
    self.postMessage({id,error: failure(type, error)});
  } finally {
    input?.dispose();
    if(outputs)for(const tensor of Object.values(outputs))tensor.dispose();
    busy=false;
  }
};
