import { WS_GATEWAY_OPTIONS, WS_MAX_PAYLOAD_BYTES } from './ws-gateway-options';

describe('WS_GATEWAY_OPTIONS', () => {
  it('ogranicza rozmiar wiadomości (engine.io domyślnie 1 MB, bez acka przy przekroczeniu)', () => {
    expect(WS_MAX_PAYLOAD_BYTES).toBe(256 * 1024);
    expect(WS_GATEWAY_OPTIONS.maxHttpBufferSize).toBe(WS_MAX_PAYLOAD_BYTES);
  });
});
