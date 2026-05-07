import PDFDocument from 'pdfkit';

// ── Constantes de diseño ──────────────────────────────────────────────────
const COLORS = {
    primary:    '#1a1a2e',
    accent:     '#e94560',
    text:       '#2d2d2d',
    subtext:    '#666666',
    bgHeader:   '#1a1a2e',
    line:       '#e94560',
};

const FONT = {
    title:  18,
    meta:   9,
    body:   11,
    footer: 8,
};

// ── Genera un buffer PDF desde texto plano ────────────────────────────────
const generatePDF = (text, title = 'Documento', author = 'Rikka-TakaradaMD') => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 60, bottom: 60, left: 55, right: 55 },
            info: {
                Title:    title,
                Author:   author,
                Creator:  'Rikka-TakaradaMD Bot',
                Subject:  'Texto convertido a documento',
            },
        });

        const chunks = [];
        doc.on('data',  chunk => chunks.push(chunk));
        doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
        doc.on('error', err   => reject(err));

        const pageW = doc.page.width;
        const pageH = doc.page.height;
        const marginL = doc.page.margins.left;
        const marginR = doc.page.margins.right;
        const contentW = pageW - marginL - marginR;

        // ── Función reutilizable: cabecera de página ──────────────────────
        const drawHeader = () => {
            // Barra superior
            doc.rect(0, 0, pageW, 40)
               .fill(COLORS.bgHeader);

            // Título en la barra
            doc.fillColor('#ffffff')
               .fontSize(FONT.meta + 1)
               .font('Helvetica-Bold')
               .text(title.toUpperCase(), marginL, 14, {
                   width: contentW - 80,
                   ellipsis: true,
               });

            // Badge lateral
            doc.fillColor(COLORS.accent)
               .roundedRect(pageW - marginR - 60, 10, 60, 20, 4)
               .fill();
            doc.fillColor('#ffffff')
               .fontSize(FONT.meta - 1)
               .font('Helvetica-Bold')
               .text('📄 PDF', pageW - marginR - 55, 15, { width: 50, align: 'center' });

            // Línea decorativa bajo la barra
            doc.moveTo(0, 40).lineTo(pageW, 40).strokeColor(COLORS.line).lineWidth(2).stroke();

            // Fecha de creación
            const fecha = new Date().toLocaleDateString('es-ES', {
                year: 'numeric', month: 'long', day: 'numeric',
            });
            doc.fillColor(COLORS.subtext)
               .fontSize(FONT.meta)
               .font('Helvetica')
               .text(`Generado el ${fecha} · ${author}`, marginL, 48, { width: contentW });
        };

        // ── Función reutilizable: pie de página ───────────────────────────
        const drawFooter = (pageNum) => {
            const y = pageH - 35;
            doc.moveTo(marginL, y).lineTo(pageW - marginR, y)
               .strokeColor(COLORS.line).lineWidth(0.5).stroke();

            doc.fillColor(COLORS.subtext)
               .fontSize(FONT.footer)
               .font('Helvetica')
               .text(`${author} · Documento generado automáticamente`, marginL, y + 6, {
                   width: contentW - 40,
               })
               .text(`Pág. ${pageNum}`, pageW - marginR - 40, y + 6, {
                   width: 40,
                   align: 'right',
               });
        };

        // ── Primera página: cabecera + separador de título ────────────────
        drawHeader();

        doc.moveDown(3);

        // Línea decorativa de título
        doc.fillColor(COLORS.accent)
           .rect(marginL, doc.y, 4, 22)
           .fill();

        doc.fillColor(COLORS.primary)
           .fontSize(FONT.title)
           .font('Helvetica-Bold')
           .text(title, marginL + 12, doc.y, { width: contentW - 12 });

        doc.moveDown(0.6);

        // Separador
        doc.moveTo(marginL, doc.y)
           .lineTo(pageW - marginR, doc.y)
           .strokeColor('#dddddd').lineWidth(0.8).stroke();

        doc.moveDown(1);

        // ── Cuerpo del texto ─────────────────────────────────────────────
        let pageNum = 1;
        drawFooter(pageNum);

        doc.on('pageAdded', () => {
            pageNum++;
            drawHeader();
            doc.moveDown(3.5); // Espacio bajo el header en páginas nuevas
            drawFooter(pageNum);
        });

        // Párrafos separados por doble salto de línea
        const paragraphs = text.split(/\n{2,}/);

        for (const para of paragraphs) {
            const lines = para.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();

                if (!trimmed) {
                    doc.moveDown(0.4);
                    continue;
                }

                // Detectar posibles "títulos" en el texto (ej: líneas en MAYUS o con ##)
                const isHeading = /^#{1,3}\s/.test(trimmed) || /^[A-ZÁÉÍÓÚÑ\s]{5,}$/.test(trimmed);

                if (isHeading) {
                    const headText = trimmed.replace(/^#{1,3}\s*/, '');
                    doc.moveDown(0.5)
                       .fillColor(COLORS.primary)
                       .fontSize(FONT.body + 2)
                       .font('Helvetica-Bold')
                       .text(headText, { width: contentW });
                    doc.moveDown(0.3);
                } else {
                    doc.fillColor(COLORS.text)
                       .fontSize(FONT.body)
                       .font('Helvetica')
                       .text(trimmed, {
                           width:       contentW,
                           align:       'justify',
                           lineGap:     3,
                           paragraphGap: 4,
                       });
                }
            }
            doc.moveDown(0.5);
        }

        doc.end();
    });
};

// ── Handler principal ────────────────────────────────────────────────────
const handler = async (m, { conn, client, text, args, usedPrefix, command }) => {
    const socket = conn || client;

    // Obtener texto: args directos, texto completo, o mensaje citado
    let content  = text?.trim() || args.join(' ').trim();
    let docTitle = 'Documento';

    if (!content && m.quoted?.text) {
        content = m.quoted.text.trim();
    }

    if (!content) {
        return socket.sendMessage(m.chat, {
            text:
`╭━━━〔 📄 TXT → PDF 〕━━━⬣
┃ *Uso:*
┃ • ${usedPrefix}${command} _Tu texto largo aquí_
┃ • Responde un mensaje con ${usedPrefix}${command}
┃
┃ *Opciones de título:*
┃ • ${usedPrefix}${command} --titulo Mi Titulo | texto...
╰━━━━━━━━━━━━━━━━━━━━━━━⬣`,
        }, { quoted: m });
    }

    // Extraer --titulo si se pasa
    const titleMatch = content.match(/--titulo\s+(.+?)(?:\||$)/i);
    if (titleMatch) {
        docTitle = titleMatch[1].trim();
        content  = content.replace(/--titulo\s+.+?(\||$)/i, '').replace(/^\|/, '').trim();
    } else if (content.length > 0) {
        // Auto-título: primeras palabras del texto (máx 50 chars)
        const firstLine = content.split('\n')[0].replace(/^#+\s*/, '').trim();
        docTitle = firstLine.length > 50
            ? firstLine.slice(0, 47) + '…'
            : firstLine || 'Documento';
    }

    if (content.length < 10) {
        return socket.sendMessage(m.chat, {
            text: '❌ El texto es demasiado corto para generar un documento.',
        }, { quoted: m });
    }

    try {
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        const pdfBuffer = await generatePDF(content, docTitle, 'Rikka-TakaradaMD');

        const words    = content.split(/\s+/).length;
        const chars    = content.length;
        const fileName = `${docTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')}.pdf`;

        const caption =
`╭━━━〔 📄 DOCUMENTO GENERADO 〕━━━⬣
┃ ◈ *Título:* ${docTitle}
┃ ✦ *Palabras:* ${words.toLocaleString('es')}
┃ ✧ *Caracteres:* ${chars.toLocaleString('es')}
┃ ◷ *Tamaño:* ${(pdfBuffer.length / 1024).toFixed(1)} KB
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣`;

        await socket.sendMessage(m.chat, { text: caption }, { quoted: m });

        await socket.sendMessage(m.chat, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName,
        }, { quoted: m });

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        console.error('[txt2pdf ERROR]', e.stack);
        await Promise.all([
            socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }),
            socket.sendMessage(m.chat, {
                text: `❌ *Error al generar el PDF:* ${e.message}`,
            }, { quoted: m }),
        ]);
    }
};

handler.help    = ['txt2pdf <texto>', 'txt2pdf --titulo Mi Titulo | texto'];
handler.tags    = ['herramientas'];
handler.command = /^(txt2pdf|texto2pdf|textdoc|txt2doc)$/i;

export default handler;
