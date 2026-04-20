/**
 * Generate a preview of the email format with CT data.
 * Run: node scripts/preview-email.mjs && open /tmp/saq-email-preview.html
 */
import fs from 'fs';

const CATEGORY_ACCENT = {
  veryHighValue:'#9A7D0A', sparklingAndChampagne:'#6C3483', redWine:'#7B1B1B',
  whiteWine:'#7D6608', roseWine:'#B03A6A', otherWine:'#5D4037',
  spirits:'#37474F', beerAndCider:'#9A6B00', misc:'#546E7A',
};

const EMAIL_CATEGORIES = [
  { key:'veryHighValue',         emoji:'💎', label:'Very High Value (>$600)'    },
  { key:'sparklingAndChampagne', emoji:'🥂', label:'Sparkling Wine & Champagne' },
  { key:'redWine',               emoji:'🍷', label:'Red Wine'                   },
  { key:'whiteWine',             emoji:'🍾', label:'White Wine'                 },
  { key:'roseWine',              emoji:'🌹', label:'Rosé Wine'                  },
  { key:'otherWine',             emoji:'🍇', label:'Other Wine'                 },
  { key:'spirits',               emoji:'🥃', label:'Spirits'                    },
  { key:'beerAndCider',          emoji:'🍺', label:'Beer & Cider'               },
  { key:'misc',                  emoji:'📦', label:'Misc'                       },
];

function categorizeEvent(r) {
  if (r.price > 600) return 'veryHighValue';
  const url = r.url.toLowerCase();
  if (url.includes('/champagne-and-sparkling-wine/') || url.includes('/wine/sparkling-wine/')) return 'sparklingAndChampagne';
  if (url.includes('/wine/red-wine/'))   return 'redWine';
  if (url.includes('/wine/white-wine/')) return 'whiteWine';
  if (url.includes('/wine/rose'))        return 'roseWine';
  if (url.includes('/wine/') || url.includes('/dessert-wine/') || url.includes('/port-and-fortified-wine/') || url.includes('/sake/') || url.includes('/aperitif/')) return 'otherWine';
  if (url.includes('/spirit/')) return 'spirits';
  if (url.includes('/beer/') || url.includes('/cider/')) return 'beerAndCider';
  return 'misc';
}

function availBadge(avail) {
  let bg, fg, text;
  if (avail.includes('Online') && avail.includes('In store')) { bg='#E8F5E9'; fg='#1B5E20'; text='Online &amp; In store'; }
  else if (avail.includes('In store')) { bg='#E8F5E9'; fg='#1B5E20'; text='In store'; }
  else if (avail.includes('Online'))   { bg='#E3F2FD'; fg='#0D47A1'; text='Online'; }
  else if (avail.includes('shortly'))  { bg='#FFF3E0'; fg='#E65100'; text='Coming soon'; }
  else if (avail.includes('lottery') || avail.includes('Lottery')) { bg='#EDE7F6'; fg='#4A148C'; text='Lottery'; }
  else { bg='#F5F5F5'; fg='#757575'; text=avail.split(',')[0]; }
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:0.3px;white-space:nowrap">${text}</span>`;
}

function ctScoreHtml(score, count, ctUrl) {
  if (!score) return '';
  const color = score >= 93 ? '#7B1B1B' : score >= 88 ? '#9A6B00' : '#555';
  const cnt   = count ? ` · ${count.toLocaleString()} notes` : '';
  const inner = `<span style="font-weight:800;font-size:13px;color:${color}">CT ${score}</span>` +
                `<span style="font-size:11px;color:#888">/100${cnt}</span>`;
  return ctUrl ? `<a href="${ctUrl}" style="text-decoration:none">${inner}</a>` : inner;
}

function ctPriceHtml(price, usdCadRate) {
  if (!price) return '';
  if (usdCadRate) {
    const cad = price * usdCadRate;
    return `<span style="font-size:11px;color:#888">CT avg <strong style="color:#555">$${cad.toFixed(0)} CAD</strong></span>`;
  }
  return `<span style="font-size:11px;color:#888">CT avg <strong style="color:#555">$${price.toFixed(0)} USD</strong></span>`;
}

function renderCard(r, accent, geoLabel, usdCadRate) {
  const tagBg   = r.isNewArrival ? '#4A235A' : '#1A5C38';
  const tagText = r.isNewArrival ? 'NEW ARRIVAL' : 'NOW AVAILABLE';
  const tag = `<span style="background:${tagBg};color:#fff;font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:0.8px">${tagText}</span>`;
  const nameYear = r.vintage ? `${r.name} <span style="color:#888;font-weight:400">${r.vintage}</span>` : r.name;
  const nameHtml = `<a href="${r.url}" style="color:#7B1B1B;text-decoration:none;font-size:14px;font-weight:700">${nameYear}</a>`;
  const meta1Parts = [r.producer, r.region, r.country].filter(Boolean);
  const meta1 = meta1Parts.length ? `<div style="color:#7A6A6A;font-size:12px;margin-top:3px">${meta1Parts.join(' &nbsp;·&nbsp; ')}</div>` : '';
  const meta2Parts = [r.grape, r.format].filter(Boolean);
  const meta2 = meta2Parts.length ? `<div style="color:#999;font-size:11px;margin-top:2px">${meta2Parts.join(' &nbsp;·&nbsp; ')}</div>` : '';
  const ctScore = ctScoreHtml(r.ctScore, r.ctScoreCount, r.ctUrl);
  const ctPrice = ctPriceHtml(r.ctPrice, usdCadRate);
  const ctLine  = [ctScore, ctPrice].filter(Boolean).join(' &nbsp;&nbsp; ');
  const ctHtml  = ctLine ? `<div style="margin-top:4px">${ctLine}</div>` : '';
  const price = `<div style="font-size:22px;font-weight:800;color:#7B1B1B;line-height:1.1">$${r.price.toFixed(2)}</div>`;
  const storeStr = r.currentStoreCount > 0 ? `${r.currentStoreCount} store${r.currentStoreCount !== 1 ? 's' : ''}${geoLabel}` : 'Online only';
  const stores = `<div style="font-size:11px;color:#888;margin-top:4px">${storeStr}</div>`;
  const link = `<a href="${r.url}" style="font-size:11px;color:#7B1B1B;text-decoration:none">→ View on SAQ.com</a>`;

  return `<tr>
  <td style="border-left:4px solid ${accent};background:#fff;padding:12px 16px 8px;border-bottom:1px solid #F0E8E8">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top;padding-right:12px">
        <div style="margin-bottom:5px">${tag}</div>
        <div style="margin-bottom:2px">${nameHtml}</div>
        ${meta1}${meta2}${ctHtml}
        <div style="margin-top:7px">${link}</div>
      </td>
      <td width="130" style="vertical-align:top;text-align:right;white-space:nowrap">
        ${price}${stores}
        <div style="margin-top:6px">${availBadge(r.currentAvailability)}</div>
      </td>
    </tr></table>
  </td>
</tr>`;
}

function buildEmailHtml(items, geoLabel, usdCadRate) {
  const total = items.length;
  const date  = new Date().toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const grouped = new Map(EMAIL_CATEGORIES.map(({key}) => [key, []]));
  for (const item of items) grouped.get(categorizeEvent(item)).push(item);

  const pillHtml = EMAIL_CATEGORIES
    .filter(({key}) => grouped.get(key).length > 0)
    .map(({key, emoji, label}) => {
      const acc = CATEGORY_ACCENT[key];
      const short = label.replace(/\s*\(.*?\)/, '');
      return `<span style="display:inline-block;background:${acc};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;margin:3px 4px 3px 0;white-space:nowrap">${emoji} ${short} (${grouped.get(key).length})</span>`;
    }).join('');

  const sectionsHtml = EMAIL_CATEGORIES
    .filter(({key}) => grouped.get(key).length > 0)
    .map(({key, emoji, label}) => {
      const acc   = CATEGORY_ACCENT[key];
      const group = grouped.get(key).sort((a,b) => b.price - a.price);
      const cards = group.map(r => renderCard(r, acc, geoLabel, usdCadRate)).join('\n');
      return `
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-radius:6px;overflow:hidden;border:1px solid #E8D5D5">
  <tr><td style="background:${acc};padding:9px 16px;color:#fff;font-size:14px;font-weight:700">
    ${emoji}&nbsp; ${label} <span style="opacity:0.75;font-weight:400">(${group.length})</span>
  </td></tr>
  <tr><td style="padding:0"><table width="100%" cellpadding="0" cellspacing="0">${cards}</table></td></tr>
</table>`;
    }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#F8F0F0">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto">
  <tr><td style="background:#7B1B1B;border-radius:8px 8px 0 0;padding:20px 24px">
    <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">🍷 SAQ Alert</div>
    <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">${total} product${total!==1?'s':''} now available &nbsp;·&nbsp; ${date}</div>
  </td></tr>
  <tr><td style="background:#F5ECEA;border:1px solid #E8D5D5;border-top:none;padding:10px 16px">${pillHtml}</td></tr>
  <tr><td style="padding:4px 0 24px">${sectionsHtml}</td></tr>
  <tr><td style="text-align:center;padding:8px;color:#bbb;font-size:11px;font-family:sans-serif">SAQ MCP &nbsp;·&nbsp; watch-all mode</td></tr>
</table></body></html>`;
}

const geoLabel = ' within 100 km of Montréal';
const SAMPLES = [
  { sku:'00102046', name:'Pétrus', vintage:'2018', price:3200, url:'https://www.saq.com/en/products/wine/red-wine/pomerol/petrus/00102046', isNewArrival:true, currentStoreCount:0, currentAvailability:'Online', previousAvailability:'', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'Établissements Moueix', region:'Pomerol', country:'France', grape:'Merlot', format:'750 ml', ctScore:96, ctScoreCount:847, ctPrice:3800, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=123456' },
  { sku:'00019248', name:'Dom Pérignon', vintage:'2015', price:329, url:'https://www.saq.com/en/products/champagne-and-sparkling-wine/champagne/dom-perignon/00019248', isNewArrival:false, currentStoreCount:5, currentAvailability:'In store', previousAvailability:'Sold out', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'Moët & Chandon', region:'Champagne', country:'France', grape:'Chardonnay, Pinot Noir', format:'750 ml', ctScore:97, ctScoreCount:2341, ctPrice:295, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=19248' },
  { sku:'14945370', name:'Gevrey-Chambertin Premier Cru Les Cazetiers', vintage:'2020', price:185, url:'https://www.saq.com/en/products/wine/red-wine/bourgogne-rouge/gevrey-chambertin/14945370', isNewArrival:true, currentStoreCount:3, currentAvailability:'In store', previousAvailability:'', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'Rossignol-Trapet', region:'Burgundy', country:'France', grape:'Pinot Noir', format:'750 ml', ctScore:93, ctScoreCount:412, ctPrice:160, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=78901' },
  { sku:'00013440', name:'Chablis Grand Cru Vaudesir', vintage:'2021', price:89, url:'https://www.saq.com/en/products/wine/white-wine/bourgogne-blanc/chablis/00013440', isNewArrival:false, currentStoreCount:7, currentAvailability:'Online, In store', previousAvailability:'Sold out', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'William Fèvre', region:'Chablis', country:'France', grape:'Chardonnay', format:'750 ml', ctScore:91, ctScoreCount:1024, ctPrice:72, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=13440' },
  // Rosé — no CT data, shows graceful absence
  { sku:'12345678', name:'Château Minuty Rosé', vintage:'2023', price:28, url:'https://www.saq.com/en/products/wine/rose-wine/provence/minuty/12345678', isNewArrival:true, currentStoreCount:12, currentAvailability:'In store', previousAvailability:'', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'Château Minuty', region:'Provence', country:'France', grape:'Grenache, Cinsault', format:'750 ml' },
  { sku:'00047889', name:'The Macallan 18 Ans Sherry Oak', price:380, url:'https://www.saq.com/en/products/spirit/whisky/scotch-whisky-single-malt/macallan/00047889', isNewArrival:false, currentStoreCount:2, currentAvailability:'In store', previousAvailability:'Sold out', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'The Macallan Distillery', region:'Speyside', country:'Scotland', format:'700 ml', ctScore:95, ctScoreCount:1876, ctPrice:340, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=47889' },
  { sku:'00098765', name:'Westvleteren 12', price:22, url:'https://www.saq.com/en/products/beer/craft-beer/trappist/westvleteren/00098765', isNewArrival:true, currentStoreCount:4, currentAvailability:'In store', previousAvailability:'', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'Sint-Sixtusabdij', region:'West Flanders', country:'Belgium', format:'330 ml', ctScore:100, ctScoreCount:4200, ctPrice:18, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=98765' },
  { sku:'00801234', name:'Barolo Riserva Vigna Rionda', vintage:'2017', price:649, url:'https://www.saq.com/en/products/wine/red-wine/piemonte-rouge/barolo/00801234', isNewArrival:true, currentStoreCount:1, currentAvailability:'In store', previousAvailability:'', previousStoreCount:0, newStoreIds:[], availabilityChanged:true, detectedAt:new Date().toISOString(), producer:'Giacomo Conterno', region:'Barolo, Piedmont', country:'Italy', grape:'Nebbiolo', format:'750 ml', ctScore:98, ctScoreCount:134, ctPrice:580, ctUrl:'https://www.cellartracker.com/wine.asp?iWine=801234' },
];

async function main() {
  let usdCadRate = null;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=CAD',
      { headers: { 'User-Agent': 'saq-mcp/1.0' }, signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const json = await res.json();
      usdCadRate = json?.rates?.CAD ?? null;
    }
  } catch {}
  if (usdCadRate) console.log(`USD/CAD rate: ${usdCadRate.toFixed(4)}`);
  else console.log('USD/CAD rate unavailable — falling back to USD display');

  const html = buildEmailHtml(SAMPLES, geoLabel, usdCadRate);
  fs.writeFileSync('/tmp/saq-email-preview.html', html);
  console.log('Preview written to /tmp/saq-email-preview.html');
}

main();
