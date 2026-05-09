#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import PhoneValidator from './PhoneValidator.js';

class PhoneAnalyzer {
  constructor() {
    this.phoneValidator = new PhoneValidator();
    this.cacheFile  = path.join(process.cwd(), 'src', 'lidsresolve.json');
    this.backupFile = path.join(process.cwd(), 'src', 'lidsresolve.backup.json');
  }

  // ─── I/O ────────────────────────────────────────────────────────────────────

  loadData() {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        console.error(`❌ Archivo no encontrado: ${this.cacheFile}`);
        return null;
      }
      return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch (err) {
      console.error('❌ Error cargando datos:', err.message);
      return null;
    }
  }

  saveData(data) {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ Error guardando datos:', err.message);
    }
  }

  createBackup(data) {
    try {
      fs.writeFileSync(this.backupFile, JSON.stringify(data, null, 2), 'utf8');
      console.log(`💾 Respaldo creado: ${this.backupFile}`);
    } catch (err) {
      console.error('❌ Error creando respaldo:', err.message);
    }
  }

  // ─── Análisis ────────────────────────────────────────────────────────────────

  analyzeEntries(data) {
    const analysis = {
      phoneNumbers: [],   // lidKey que en realidad son números de teléfono
      realLids:     [],   // lidKey que son LIDs reales
      problematic:  [],   // entradas con jid que sigue siendo @lid
      correctable:  [],   // phoneNumbers que necesitan corrección
      stale:        [],   // entradas notFound/error que se pueden limpiar
      alreadyFixed: [],   // phoneNumbers ya corregidos previamente
    };

    for (const [lidKey, entry] of Object.entries(data)) {
      // Protección contra entradas malformadas
      if (!entry || typeof entry !== 'object') continue;

      const jid = entry.jid || '';
      const detection = this.phoneValidator.detectPhoneInLid(lidKey);

      if (detection.isPhone) {
        const countryInfo = this.phoneValidator.getCountryInfo(detection.phoneNumber);
        const jidStillLid = jid.includes('@lid');
        const isProblematic = entry.notFound || entry.error || jidStillLid;
        const alreadyFixed  = entry.corrected && !isProblematic && jid.includes('@s.whatsapp.net');

        const phoneEntry = {
          lidKey,
          phoneNumber:  detection.phoneNumber,
          correctJid:   detection.jid,
          currentJid:   jid,
          country:      countryInfo?.country || 'Desconocido',
          countryCode:  countryInfo?.code    || '??',
          isProblematic,
          alreadyFixed,
          entry,
        };

        analysis.phoneNumbers.push(phoneEntry);

        if (alreadyFixed) {
          analysis.alreadyFixed.push(phoneEntry);
        } else if (isProblematic) {
          analysis.correctable.push(phoneEntry);
        }
      } else {
        analysis.realLids.push({ lidKey, entry });
      }

      // Entradas sin JID útil (basura acumulada)
      if (entry.notFound || entry.error) {
        analysis.stale.push({ lidKey, reason: entry.notFound ? 'notFound' : 'error', entry });
      }

      // JID que sigue siendo @lid (no resuelto)
      if (jid && jid.includes('@lid')) {
        analysis.problematic.push({ lidKey, issue: 'JID contiene @lid', entry });
      }
    }

    return analysis;
  }

  // ─── Reporte ─────────────────────────────────────────────────────────────────

  generateReport(analysis, data) {
    const total = Object.keys(data).length;
    console.log('\n📊 ═══════════ REPORTE DE ANÁLISIS ═══════════\n');
    console.log(`  Total de entradas:            ${total}`);
    console.log(`  📞 Números telefónicos:        ${analysis.phoneNumbers.length}`);
    console.log(`     ✅ Ya corregidos:           ${analysis.alreadyFixed.length}`);
    console.log(`     🔧 Por corregir:            ${analysis.correctable.length}`);
    console.log(`  🔗 LIDs reales:                ${analysis.realLids.length}`);
    console.log(`  🗑️  Entradas obsoletas (stale): ${analysis.stale.length}`);
    console.log(`  ⚠️  JIDs sin resolver (@lid):  ${analysis.problematic.length}`);

    // Por país
    if (analysis.phoneNumbers.length > 0) {
      console.log('\n  📍 Números por país:');
      const countries = {};
      for (const p of analysis.phoneNumbers) {
        if (!countries[p.country]) countries[p.country] = { total: 0, fixed: 0, pending: 0 };
        countries[p.country].total++;
        if (p.alreadyFixed)   countries[p.country].fixed++;
        if (p.isProblematic && !p.alreadyFixed) countries[p.country].pending++;
      }
      for (const [country, s] of Object.entries(countries)) {
        const detail = s.pending > 0 ? ` — ${s.pending} pendiente(s)` : '';
        console.log(`     ${country}: ${s.total} (${s.fixed} OK${detail})`);
      }
    }

    // Entradas corregibles (primeras 10)
    if (analysis.correctable.length > 0) {
      console.log('\n  🔧 Entradas a corregir (max 10):');
      for (const c of analysis.correctable.slice(0, 10)) {
        console.log(`     ${c.lidKey}  [${c.country}]`);
        console.log(`       Actual:  ${c.currentJid}`);
        console.log(`       Correcto: ${c.correctJid}`);
      }
      if (analysis.correctable.length > 10)
        console.log(`     ... y ${analysis.correctable.length - 10} más`);
    }

    // Entradas stale
    if (analysis.stale.length > 0) {
      console.log(`\n  🗑️  Entradas obsoletas (primeras 10):`);
      for (const s of analysis.stale.slice(0, 10)) {
        console.log(`     ${s.lidKey}  [${s.reason}]`);
      }
      if (analysis.stale.length > 10)
        console.log(`     ... y ${analysis.stale.length - 10} más`);
    }

    console.log('\n══════════════════════════════════════════════\n');
  }

  // ─── Correcciones ────────────────────────────────────────────────────────────

  applyCorrections(data, analysis, options = {}) {
    const correctedData = { ...data };
    let fixed = 0;
    let cleaned = 0;

    // 1. Corregir phoneNumbers problemáticos
    for (const c of analysis.correctable) {
      const { lidKey, correctJid, phoneNumber, country } = c;
      // Guardar sin originalEntry para no inflar el JSON
      correctedData[lidKey] = {
        jid:         correctJid,
        lid:         `${lidKey}@lid`,
        name:        phoneNumber,
        timestamp:   Date.now(),
        corrected:   true,
        country:     country,
        phoneNumber: phoneNumber,
      };
      fixed++;
    }

    // 2. Limpiar entradas stale si se pidió
    if (options.clean) {
      for (const s of analysis.stale) {
        // Solo eliminar si no fue ya corregida en el paso anterior
        if (!analysis.correctable.find(c => c.lidKey === s.lidKey)) {
          delete correctedData[s.lidKey];
          cleaned++;
        }
      }
    }

    return { data: correctedData, fixed, cleaned };
  }

  // ─── Entrada principal ───────────────────────────────────────────────────────

  run(options = {}) {
    const data = this.loadData();
    if (!data) return;

    const analysis = this.analyzeEntries(data);

    if (!options.silent) this.generateReport(analysis, data);

    const nothingToDo = analysis.correctable.length === 0 &&
                        (!options.clean || analysis.stale.length === 0);

    if (nothingToDo) {
      if (!options.silent) console.log('✅ No hay correcciones pendientes.');
      return analysis;
    }

    if (options.dryRun) {
      if (!options.silent) {
        console.log(`🔍 Dry-run: se corregirían ${analysis.correctable.length} entradas` +
          (options.clean ? ` y se limpiarían ${analysis.stale.length} obsoletas` : '') + '.');
      }
      return analysis;
    }

    if (options.fix) {
      this.createBackup(data);
      const { data: correctedData, fixed, cleaned } = this.applyCorrections(data, analysis, options);
      this.saveData(correctedData);
      if (!options.silent) {
        if (fixed)   console.log(`✅ ${fixed} entradas corregidas.`);
        if (cleaned) console.log(`🗑️  ${cleaned} entradas obsoletas eliminadas.`);
      }
    } else if (!options.silent) {
      console.log(`💡 Ejecuta con --fix para aplicar ${analysis.correctable.length} correcciones.`);
      if (analysis.stale.length > 0)
        console.log(`   Agrega --clean para eliminar también ${analysis.stale.length} entradas obsoletas.`);
    }

    return analysis;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {
    fix:     args.includes('--fix')      || args.includes('-f'),
    dryRun:  args.includes('--dry-run')  || args.includes('-d'),
    clean:   args.includes('--clean')    || args.includes('-c'),
    silent:  args.includes('--silent')   || args.includes('-s'),
  };

  if (!options.silent) console.log('📱 ═══ REPARADOR DE NÚMEROS / JIDs ═══\n');

  new PhoneAnalyzer().run(options);
}

export default PhoneAnalyzer;
    
