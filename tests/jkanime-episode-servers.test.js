import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJkAnimeEpisodeUrl,
  parseJkPlayersRedirectUrl,
  resolveJkAnimeEpisodeInput,
} from '../plugins/lib/jkanime-episode-servers.js'
import { parseByseUrl } from '../plugins/byse-dl.js'
import { parseStreamWishUrl } from '../plugins/streamwish-dl.js'
import { parseVidHideUrl } from '../plugins/vidhide-dl.js'
import { parseStreamTapeUrl } from '../plugins/streamtape-dl.js'
import { parseDoodStreamUrl } from '../plugins/doodstream-dl.js'

const episode = 'https://jkanime.net/kyoufu-collector/7/'
const b64 = value => Buffer.from(value).toString('base64')
const html = `
<script>
var servers = [
  {"server":"Filemoon","remote":"${b64('https://bysekoze.com/e/ldrk67q0kwiw')}","slug":"ldrk67q0kwiw"},
  {"server":"Streamwish","remote":"${b64('https://vibuxer.com/f/87wzxbc2xijd')}","slug":"87wzxbc2xijd"},
  {"server":"Vidhide","remote":"${b64('https://callistanise.com/file/4t8obkq2pwnr')}","slug":"4t8obkq2pwnr"},
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
    byse: 'https://bysekoze.com/e/ldrk67q0kwiw',
    streamwish: 'https://vibuxer.com/f/87wzxbc2xijd',
    vidhide: 'https://callistanise.com/file/4t8obkq2pwnr',
    streamtape: 'https://streamtape.com/e/st-id',
    doodstream: 'https://dood.wf/e/ds-id',
    mixdrop: 'https://mixdrop.ag/e/md-id',
  }
  for (const [provider, url] of Object.entries(expected)) {
    assert.equal(await resolveJkAnimeEpisodeInput(episode, provider, { fetchPage: mockFetch() }), url)
  }
  assert.equal(parseByseUrl(expected.byse).code, 'ldrk67q0kwiw')
  assert.equal(parseStreamWishUrl(expected.streamwish).id, '87wzxbc2xijd')
  assert.equal(parseVidHideUrl(expected.vidhide).id, '4t8obkq2pwnr')
})

test('resuelve redirecciones de descarga c1.jkplayers.com/d/... y rutas /f/', async () => {
  const dlUrl = 'https://c1.jkplayers.com/d/0Cs92624xLO3Y/'
  assert.equal(parseJkPlayersRedirectUrl(dlUrl), dlUrl)
  assert.equal(parseJkPlayersRedirectUrl('https://evil.example/d/abc123/'), null)

  const target = 'https://streamtape.com/f/qW6g361aLYfRdD/video-07.mp4'
  const resolved = await resolveJkAnimeEpisodeInput(dlUrl, 'streamtape', {
    fetchPage: async () => ({ status: 302, headers: new Headers({ location: target }) }),
  })
  assert.equal(resolved, target)
  assert.equal(parseStreamTapeUrl(resolved).id, 'qW6g361aLYfRdD')
  assert.equal(parseByseUrl('https://bysekoze.com/f/ldrk67q0kwiw/').code, 'ldrk67q0kwiw')
  assert.equal(parseDoodStreamUrl('https://dsvplay.com/f/wsj0f35bkcei').id, 'wsj0f35bkcei')
  assert.equal(parseDoodStreamUrl('https://playmogo.com/e/wsj0f35bkcei').id, 'wsj0f35bkcei')
})

test('resuelve los reproductores Magi, Desu y JKPlayer por tipo de ruta', async () => {
  assert.equal(await resolveJkAnimeEpisodeInput(episode, 'magi', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/umv?e=magi-token')
  assert.equal(await resolveJkAnimeEpisodeInput(episode, 'desu', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/um?e=desu-token')
  assert.equal(await resolveJkAnimeEpisodeInput(episode, 'jkplayer', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/um?e=desu-token')
})

test('no ejecuta JavaScript y rechaza matriz malformada o proveedor ausente', async () => {
  let executed = false
  const invalid = `<script>globalThis.__ran = true; var servers = getServers();</script>`
  await assert.rejects(resolveJkAnimeEpisodeInput(episode, 'byse', { fetchPage: mockFetch(invalid) }), /no publica un servidor byse válido/)
  assert.equal(executed, false)
  await assert.rejects(resolveJkAnimeEpisodeInput(episode, 'byse', { fetchPage: mockFetch(html, 'https://elsewhere.example/redirect') }), /dominio inesperado/)
})

test('las URLs directas pasan sin hacer una petición', async () => {
  let requests = 0
  const direct = 'https://bysekoze.com/e/abc123'
  const output = await resolveJkAnimeEpisodeInput(direct, 'byse', { fetchPage: async () => { requests += 1 } })
  assert.equal(output, direct)
  assert.equal(requests, 0)
})
