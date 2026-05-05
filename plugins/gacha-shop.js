// gacha-shop.js — Vender, comprar y ver tienda de waifus
// Portado de YukiBot-MD → Rikka-TakaradaMD

const handler = async (m, { conn, command, args, usedPrefix }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {};
  const chat = global.db.data.chats[m.chat];




  if (chat.gacha === false) {
    return m.reply(`╰─► El *Gacha* está desactivado en este grupo.\n⇢ Un *admin* puede activarlo con *${usedPrefix}gacha on*`);
  }

  // ─── SELL ───────────────────────────────────────────────────
  if (['sell', 'vender'].includes(command)) {
    if (args.length < 2) {
      return m.reply(`⸙͎ Uso: *${usedPrefix}sell <precio> <personaje>*\n↳ Ejemplo: *${usedPrefix}sell 5000 Rem*`);
    }
    const price = parseInt(args[0]);
    if (isNaN(price) || price < 2000)       return m.reply('↳ ✗ El precio mínimo es *¥2,000*.');
    if (price > 100_000_000)                return m.reply('↳ ✗ El precio máximo es *¥100,000,000*.');
    const name   = args.slice(1).join(' ').toLowerCase();
    const idSell = Object.keys(chat.gacha_characters).find(id =>
      (chat.gacha_characters[id]?.name || '').toLowerCase() === name
    );
    if (!idSell) return m.reply(`❲ ✗ ❳ No se encontró *${args.slice(1).join(' ')}*`);
    const charSell = chat.gacha_characters[idSell];
    if (charSell.user !== m.sender) return m.reply(`↳ ✗ *${charSell.name}* no es tuyo para venderlo.`);
    chat.gacha_sales[idSell] = { name: charSell.name, user: m.sender, price, time: Date.now() };
    const sellerName = global.db.data.users[m.sender]?.name?.trim() || m.sender.split('@')[0];
    return m.reply(`˗ˏˋ *${charSell.name}* en venta ˎˊ-\n⇢ Vendedor ➤ *${sellerName}*\n⇢ Precio ➤ *¥${price.toLocaleString()}*\n⇢ Expira en ➤ *3 días*\n↳ *${usedPrefix}wshop* para ver la tienda`);
  }

  // ─── BUYCHAR ────────────────────────────────────────────────
  if (['buyc', 'buychar', 'comprarwaifu'].includes(command)) {
    if (!args.length) {
      return m.reply(`⸙͎ Uso: *${usedPrefix}buyc <personaje>*`);
    }
    const queryBuy = args.join(' ').toLowerCase();
    const idBuy    = Object.keys(chat.gacha_sales).find(id =>
      (chat.gacha_sales[id]?.name || '').toLowerCase() === queryBuy
    );
    if (!idBuy) return m.reply(`❲ ✗ ❳ No se encontró *${args.join(' ')}* en venta.`);
    const venta = chat.gacha_sales[idBuy];
    if (venta.user === m.sender) return m.reply('↳ ✗ No puedes comprar tu propio personaje.');
    if (!chat.users[m.sender]) chat.users[m.sender] = {};
    const saldo = typeof chat.users[m.sender]?.coin === 'number' ? chat.users[m.sender].coin : 0;
    if (saldo < venta.price) {
      return m.reply(`↳ ✗ Monedas insuficientes para *${venta.name}*\n⇢ Necesitas *¥${venta.price.toLocaleString()}*`);
    }
    if (!chat.users[venta.user])                            chat.users[venta.user] = { coins: 0, characters: [] };
    if (!Array.isArray(chat.users[venta.user].characters)) chat.users[venta.user].characters = [];
    chat.users[m.sender].coin  -= venta.price;
    chat.users[venta.user].coin += venta.price;
    chat.gacha_characters[idBuy].user  = m.sender;
    if (!chat.users[m.sender].characters) chat.users[m.sender].characters = [];
    if (!chat.users[m.sender].characters.includes(idBuy)) chat.users[m.sender].characters.push(idBuy);
    chat.users[venta.user].characters = (chat.users[venta.user].characters || []).filter(id => id !== idBuy);
    if (chat.users[venta.user].favorite === idBuy) delete chat.users[venta.user].favorite;
    delete chat.gacha_sales[idBuy];
    const vendedor  = global.db.data.users[venta.user]?.name?.trim() || venta.user.split('@')[0];
    const comprador = global.db.data.users[m.sender]?.name?.trim()   || m.sender.split('@')[0];
    return m.reply(`✩ *${venta.name}* es de *${comprador}* ˑ ❁\n⇢ *¥${venta.price.toLocaleString()}* transferidos a *${vendedor}*`);
  }

  // ─── HAREMSHOP ──────────────────────────────────────────────
  if (['wshop', 'haremshop', 'tiendawaifus'].includes(command)) {
    const ahora = Date.now();
    for (const [id, v] of Object.entries(chat.gacha_sales)) {
      if (ahora - v.time >= 3 * 864e5) delete chat.gacha_sales[id];
    }
    const ventas = Object.entries(chat.gacha_sales);
    if (!ventas.length) return m.reply('↳ No hay personajes en venta actualmente.');
    const page      = parseInt(args[0]) || 1;
    const porPagina = 10;
    const totalPag  = Math.ceil(ventas.length / porPagina);
    if (page < 1 || page > totalPag) return m.reply(`ꕥ Página inválida. Total: *${totalPag}*.`);
    const listado = [];
    for (const [id, v] of ventas.slice((page - 1) * porPagina, page * porPagina)) {
      const rem   = 3 * 864e5 - (ahora - v.time);
      const d = Math.floor(rem / 86400000);
      const h = Math.floor(rem % 86400000 / 3600000);
      const mi = Math.floor(rem % 3600000 / 60000);
      const s  = Math.floor(rem % 60000 / 1000);
      const vendedor = global.db.data.users[v.user]?.name?.trim() || v.user.split('@')[0];
      const valor    = global.db.data.characters?.[id]?.value ?? chat.gacha_characters?.[id]?.value ?? 0;
      listado.push(`⇢ *${v.name}* ˑ *¥${valor}*\n  ↳ Precio ➤ *¥${v.price.toLocaleString()}*\n  ↳ Vendedor ➤ *${vendedor}*\n  ↳ Expira ➤ *${d}d ${h}h ${mi}m ${s}s*`);
    }
    return m.reply(`˗ˏˋ *HaremShop* ˎˊ-\n⇢ En venta: *${ventas.length}*\n\n` + listado.join('\n\n') + `\n\n↳ Página *${page}* de *${totalPag}*`);
  }
};

handler.command = ['sell', 'vender', 'buyc', 'buychar', 'comprarwaifu', 'wshop', 'haremshop', 'tiendawaifus'];
handler.tags    = ['gacha'];
handler.help    = [
  'sell <precio> <personaje> — Poner en venta una waifu',
  'buyc <personaje> — Comprar una waifu de la tienda',
  'wshop — Ver waifus en venta',
];
handler.group   = true;

export default handler;
