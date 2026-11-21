import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJkAnimeEpisodeUrl,
  resolveJkAnimeEpisodeInput,
} from '../plugins/lib/jkanime-episode-servers.js'
import { parseFilemoonUrl } from '../plugins/filemoon-dl.js'

const episode = 'https://jkanime.net/kyoufu-collector/7/'
const b64 = value => Buffer.from(value).toString('base64')
const html = `
<script>
var servers = [
  {"server":"Filemoon","remote":"${b64('https://bysekoze.com/e/ldrk67q0kwiw')}","slug":"ldrk67q0kwiw"},
  {"server":"Streamwish","remote":"${b64('https://streamwish.to/e/sw-id')}","slug":"sw-id"},
  {"server":"Vidhide","remote":"${b64('https://vidhidepro.com/v/vh-id')}","slug":"vh-id"},
  {"server":"StreamTape","remote":"${b64('https://streamtape.com/e/st-id')}","slug":"st-id"},
  {"server":"DoodStream","remote":"${b64('https://dood.wf/e/ds-id')}","slug":"ds-id"},
  {"server":"Mixdrop","remote":"${b64('https://mixdrop.ag/e/md-id')}","slug":"md-id"}
];
</script>
<script>
var video = [];
video[0] = '<iframe src="https://jkanime.net/jkplayer/um?e=desu-token"></iframe>';
video[1] = '<iframe src="https://jkanime.net/jkplayer/umv?e=magi-token"></iframe>';
</script>`

function mockFetch(text = html, finalUrl = episode) {
  return async () => ({ ok: true, status: 200, url: finalUrl, text: async () => text })
}

test('solo acepta URLs de episodio JKAnime con ruta numérica', () => {
  assert.equal(parseJkAnimeEpisodeUrl(episode), episode)
  assert.equal(parseJkAnimeEpisodeUrl('https://evil.example/kyoufu-collector/7/'), null)
  assert.equal(parseJkAnimeEpisodeUrl('https://jkanime.net/search/kyoufu/'), null)
  assert.equal(parseJkAnimeEpisodeUrl('javascript:alert(1)'), null)
})

test('resuelve los seis servidores externos por etiqueta, no por posición', async () => {
  const expected = {
    filemoon: 'https://bysekoze.com/e/ldrk67q0kwiw',
    streamwish: 'https://streamwish.to/e/sw-id',
    vidhide: 'https://vidhidepro.com/v/vh-id',
    streamtape: 'https://streamtape.com/e/st-id',
    doodstream: 'https://dood.wf/e/ds-id',
    mixdrop: 'https://mixdrop.ag/e/md-id',
  }
  for (const [provider, url] of Object.entries(expected)) {
    assert.equal(await resolveJkAnimeEpisodeInput(episode, provider, { fetchPage: mockFetch() }), url)
  }
  assert.equal(parseFilemoonUrl(expected.filemoon).id, 'ldrk67q0kwiw')
})

test('resuelve los reproductores Magi, Desu y JKPlayer por tipo de ruta', async () => {
  assert.equal(await resolveJkAnimeEpisodeInput(episode, 'magi', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/umv?e=magi-token')
  assert.equal(await resolveJkAnimeEpisodeInput(episode, 'desu', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/um?e=desu-token')
  assert.equal(await resolveJkAnimeEpisodeInput(episode, 'jkplayer', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/um?e=desu-token')
})

test('no ejecuta JavaScript y rechaza matriz malformada o proveedor ausente', async () => {
  let executed = false
  const invalid = `<script>globalThis.__ran = true; var servers = getServers();</script>`
  await assert.rejects(resolveJkAnimeEpisodeInput(episode, 'filemoon', { fetchPage: mockFetch(invalid) }), /no publica un servidor filemoon válido/)
  assert.equal(executed, false)
  await assert.rejects(resolveJkAnimeEpisodeInput(episode, 'filemoon', { fetchPage: mockFetch(html, 'https://elsewhere.example/redirect') }), /dominio inesperado/)
})

test('las URLs directas pasan sin hacer una petición', async () => {
  let requests = 0
  const direct = 'https://filemoon.sx/e/abc123'
  const output = await resolveJkAnimeEpisodeInput(direct, 'filemoon', { fetchPage: async () => { requests += 1 } })
  assert.equal(output, direct)
  assert.equal(requests, 0)
})
