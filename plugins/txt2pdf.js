import PDFDocument from 'pdfkit';

// ── Genera un buffer PDF desde texto plano ────────────────────────────────
const generatePDF = (text, title = 'Documento', author = 'Rikka-TakaradaMD') => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 70, bottom: 60, left: 55, right: 55 },
            info: {
                Title:   title,
                Author:  author,
                Creator: 'Rikka-TakaradaMD Bot',
            },
            bufferPages: true, // Necesario para escribir footer después
        });

        const chunks = [];
        doc.on('data',  chunk => chunks.push(chunk));
        doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
        doc.on('error', err   => reject(err));

        const pageW    = doc.page.width;
        const pageH    = doc.page.height;
        const mL       = doc.page.margins.left;
        const mR       = doc.page.margins.right;
        const contentW = pageW - mL - mR;

        // ── Cabecera (posición absoluta, sin afectar el cursor) ───────────
        const drawHeader = () => {
            doc.rect(0, 0, pageW, 38).fill('#1a1a2e');

            doc.fillColor('#ffffff')
               .fontSize(9).font('Helvetica-Bold')
               .text(title.length > 60 ? title.slice(0, 57) + '…' : title,
                     mL, 13, { width: contentW - 70, lineBreak: false });

            doc.fillColor('#e94560')
               .roundedRect(pageW - mR - 58, 9, 58, 20, 4).fill();
            doc.fillColor('#ffffff')
               .fontSize(8).font('Helvetica-Bold')
               .text('PDF', pageW - mR - 55, 14, { width: 52, align: 'center', lineBreak: false });

            doc.moveTo(0, 38).lineTo(pageW, 38)
               .strokeColor('#e94560').lineWidth(2).stroke();

            const fecha = new Date().toLocaleDateString('es-ES', {
                year: 'numeric', month: 'short', day: 'numeric',
            });
            doc.fillColor('#888888').fontSize(8).font('Helvetica')
               .text(`${fecha} · ${author}`, mL, 44, { width: contentW, lineBreak: false });
        };

        // ── Footer (se aplica al final sobre todas las páginas) ──────────
        const drawFooters = (totalPages) => {
            const range = doc.bufferedPageRange();
            for (let i = 0; i < range.count; i++) {
                doc.switchToPage(range.start + i);
                const y = pageH - 38;
                doc.moveTo(mL, y).lineTo(pageW - mR, y)
                   .strokeColor('#e94560').lineWidth(0.5).stroke();
                doc.fillColor('#aaaaaa').fontSize(7).font('Helvetica')
                   .text(`${author} · Documento generado automáticamente`,
                         mL, y + 6, { width: contentW - 50, lineBreak: false })
                   .text(`Pag. ${i + 1} / ${totalPages}`,
                         pageW - mR - 50, y + 6, { width: 50, align: 'right', lineBreak: false });
            }
        };

        // ── Guard: evita recursión en pageAdded ───────────────────────────
        let inPageAdded = false;
        doc.on('pageAdded', () => {
            if (inPageAdded) return;
            inPageAdded = true;
            try {
                drawHeader();
                doc.y = 62;
            } finally {
                inPageAdded = false;
            }
        });

        // ── Página 1: cabecera inicial ────────────────────────────────────
        drawHeader();
        doc.y = 62;

        // Bloque de título del documento
        doc.moveDown(0.5);
        doc.fillColor('#e94560').rect(mL, doc.y, 4, 20).fill();
        doc.fillColor('#1a1a2e').fontSize(16).font('Helvetica-Bold')
           .text(title, mL + 10, doc.y, { width: contentW - 10, lineBreak: true });
        doc.moveDown(0.5);
        doc.moveTo(mL, doc.y).lineTo(pageW - mR, doc.y)
           .strokeColor('#dddddd').lineWidth(0.6).stroke();
        doc.moveDown(0.8);

        // ── Cuerpo: párrafos ──────────────────────────────────────────────
        const paragraphs = text.split(/\n{2,}/);

        for (const para of paragraphs) {
            const lines = para.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) { doc.moveDown(0.3); continue; }

                const isHeading = /^#{1,3}\s/.test(trimmed) ||
                                  (/^[A-ZÁÉÍÓÚÑ\s\-_]{6,}$/.test(trimmed) && trimmed.length < 80);

                if (isHeading) {
                    const headText = trimmed.replace(/^#{1,3}\s*/, '');
                    doc.moveDown(0.4)
                       .fillColor('#1a1a2e').fontSize(12).font('Helvetica-Bold')
                       .text(headText, mL, doc.y, { width: contentW });
                    doc.moveDown(0.2);
                } else {
                    doc.fillColor('#2d2d2d').fontSize(11).font('Helvetica')
                       .text(trimmed, mL, doc.y, {
                           width:       contentW,
                           align:       'justify',
                           lineGap:     2,
                           paragraphGap: 2,
                       });
                }
            }
            doc.moveDown(0.4);
        }

        // ── Aplicar footers y cerrar ──────────────────────────────────────
        const totalPages = doc.bufferedPageRange().count;
        drawFooters(totalPages);

        doc.end();
    });
};

// ── Handler principal ────────────────────────────────────────────────────
const handler = async (m, { conn, client, text, args, usedPrefix, command }) => {
    const socket = conn || client;

    let content = text?.trim() || args.join(' ').trim();

    if (!content && m.quoted?.text) content = m.quoted.text.trim();

    if (!content) {
        return socket.sendMessage(m.chat, {
            text:
`╭━━━〔 📄 TXT → PDF 〕━━━⬣
┃ *Uso:*
┃ • ${usedPrefix}${command} _Tu texto largo aquí_
┃ • Responde un mensaje con ${usedPrefix}${command}
┃
┃ *Título personalizado:*
┃ • ${usedPrefix}${command} --titulo Mi Titulo | texto
╰━━━━━━━━━━━━━━━━━━━━━━━⬣`,
        }, { quoted: m });
    }

    // Extraer --titulo si se pasa
    let docTitle = '';
    const titleMatch = content.match(/--titulo\s+(.+?)(?:\s*\|\s*)/i);
    if (titleMatch) {
        docTitle = titleMatch[1].trim();
        content  = content.replace(/--titulo\s+.+?\s*\|\s*/i, '').trim();
    }

    if (!docTitle) {
        const firstLine = content.split('\n')[0].replace(/^#+\s*/, '').trim();
        docTitle = firstLine.length > 50 ? firstLine.slice(0, 47) + '…' : firstLine || 'Documento';
    }

    if (content.length < 5) {
        return socket.sendMessage(m.chat,
            { text: '❌ El texto es demasiado corto.' }, { quoted: m });
    }

    try {
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        const pdfBuffer = await generatePDF(content, docTitle, 'Rikka-TakaradaMD');

        const words    = content.trim().split(/\s+/).length;
        const fileName = `${docTitle.replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '_') || 'documento'}.pdf`;

        await socket.sendMessage(m.chat, {
            text:
`╭━━━〔 📄 DOCUMENTO GENERADO 〕━━━⬣
┃ ◈ *Título:* ${docTitle}
┃ ✦ *Palabras:* ${words.toLocaleString('es')}
┃ ✧ *Caracteres:* ${content.length.toLocaleString('es')}
┃ ◷ *Tamaño:* ${(pdfBuffer.length / 1024).toFixed(1)} KB
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣`,
        }, { quoted: m });

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
            socket.sendMessage(m.chat,
                { text: `❌ *Error al generar el PDF:* ${e.message}` }, { quoted: m }),
        ]);
    }
};

handler.help    = ['txt2pdf <texto>', 'txt2pdf --titulo Titulo | texto'];
handler.tags    = ['herramientas'];
handler.command = /^(txt2pdf|texto2pdf|textdoc|txt2doc)$/i;

export default handler;
    
