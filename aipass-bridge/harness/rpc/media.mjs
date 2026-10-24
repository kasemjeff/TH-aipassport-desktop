// The media methods of the backend: what the window asks when the person
// wants a picture, a clip or a song.
//
// The window is the caller; the bridge is the one that talks to AiPASS. Media
// is AiPASS-only — another provider has no image models — so these methods
// talk to the local bridge directly, whatever provider the runs use.
import { BridgeClient } from '../bridge.mjs';
import { generate, listModels, presets, options } from '../media.mjs';

/**
 * The media methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createMediaMethods(ctx) {
  const { bridgeURL } = ctx;
  // One client for the backend: the media surface reads the catalog and the
  // option loaders on every call, and a client per call would mint a token
  // per call.
  const client = new BridgeClient(bridgeURL);
  // The project the call is about: a relative path is relative to it (the
  // house's rule for every path the window hands over), and a file the
  // caller did not name lands outside it.
  const projectOf = (params) => ctx.targetFor?.(params)?.root ?? ctx.root ?? null;

  return {

    /**
     * The media models of the live catalog, grouped by kind, each with the
     * options it accepts.
     */
    async 'media.models'() { return listModels(client); },

    /**
     * The option surface: what one model accepts, or — with no model named —
     * the whole of it (the image styles, the video styles, what each video
     * provider is served, the tone and format presets).
     */
    async 'media.options'(params = {}) { return options(client, params.model ?? null); },

    /**
     * The presets the service publishes, in one answer: the image styles, the
     * video styles, the tones and the formats.
     */
    async 'media.styles'() { return presets(client); },

    /**
     * Run a generation and keep what it produced.
     *
     * The file lands in `out` — the state home's media folder by default, so
     * a render never ends up in the project by accident — and the answer says
     * which path was written, how big it is, and which model made it.
     */
    async 'media.generate'(params = {}) {
      return generate({
        client,
        root: projectOf(params),
        model: params.model ?? null,
        prompt: params.prompt ?? null,
        ratio: params.ratio ?? null,
        resolution: params.resolution ?? null,
        duration: params.duration ?? null,
        style: params.style ?? null,
        cameraFixed: params.cameraFixed ?? null,
        generateAudio: params.generateAudio ?? null,
        tone: params.tone ?? null,
        format: params.format ?? null,
        out: params.out ?? null,
      });
    },
  };
}

export default createMediaMethods;
