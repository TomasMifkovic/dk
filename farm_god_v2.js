// ==UserScript==
// @name         FarmMisko
// @match        https://*.divoke-kmene.sk/game.php*screen=am_farm*
// @grant        none
// @run-at       document-end
// ==/UserScript==
// (Userscript hlavička sa používa len pri RELOAD_PAGE = true cez Tampermonkey; pri spustení cez záložku/konzolu sa ignoruje.)
// javascript:$.getScript('https://scripts.cybermine.cz/FarmGod.js');
// FarmMisko v1.6.2
// v1.6.2: modrá dedina so známym múrom 0 sa rabuje ako zelená (modrá s múrom 1+ alebo '?' sa stále ignoruje).
// FarmMisko v1.6
// v1.6: červený / červeno-modrý cieľ s neznámym múrom ('?') sa PRESKAKUJE; útok s baranidlami sa plánuje len pri múre 1 alebo 2.
// FarmMisko v1.5
// v1.5: AUTOMATICKÝ REŽIM – po náhodnom čase (default 10–15 min) znova načíta dáta, naplánuje a pošle všetko (ako BLITZKRIEG).
//       Zastaví sa sám pri bot ochrane, pri opakovaných chybách, alebo tlačidlom STOP (panel vpravo dole).
// v1.4: neznámy múr ('?' vo FA) sa rieši voľbou v dialógu; šablóny sa mapujú na jednotky podľa mena, nie podľa poradia;
//       pri každom ciele v tabuľke s baranidlami je odkaz na nádvorie
// - A aj B len na barbarky < X bodov (nastaviteľné, default 87)
// - Do rabovania ide LEN zelená farba (žltá, červená, modrá, červeno-modrá, červeno-žltá sa ignorujú)
// - Checkbox "Nájsť nové barbarky" (nové sa pridajú až PO načítaní am_farm, nikdy nie tie, čo FA pozná)
// - Checkbox "Použiť blacklist z poznámok" (súradnice xxx|yyy v poznámkach)
// - NOVÉ: tabuľka červených / červeno-modrých cieľov + útok s baranidlami podľa levelu múru:
//       múr 1 -> 5 LK + 1 špeh + 4 baranidlá
//       múr 2 -> 10 LK + 1 špeh + 8 baranidiel
//   Cieľ sa zaradí LEN ak k nemu už neletí útok s baranidlami. Po dopade a zelenom reporte
//   sa cieľ sám vráti do bežného rabovania.

window.FarmGod = {};
window.FarmGod.Library = (function() {
    if (typeof window.twLib === 'undefined') {
        window.twLib = {
            queues: null,
            init: function() {
                if (this.queues === null) {
                    this.queues = this.queueLib.createQueues(5);
                }
            },
            queueLib: {
                maxAttempts: 3,
                Item: function(action, arg, promise = null) {
                    this.action = action;
                    this.arguments = arg;
                    this.promise = promise;
                    this.attempts = 0;
                },
                Queue: function() {
                    this.list = [];
                    this.working = false;
                    this.length = 0;
                    this.doNext = function() {
                        let item = this.dequeue();
                        let self = this;
                        if (item.action == 'openWindow') {
                            window.open(...item.arguments).addEventListener('DOMContentLoaded', function() {
                                self.start();
                            });
                        } else {
                            $[item.action](...item.arguments).done(function() {
                                item.promise.resolve.apply(null, arguments);
                                self.start();
                            }).fail(function() {
                                item.attempts += 1;
                                if (item.attempts < twLib.queueLib.maxAttempts) {
                                    self.enqueue(item, true);
                                } else {
                                    item.promise.reject.apply(null, arguments);
                                }
                                self.start();
                            });
                        }
                    };
                    this.start = function() {
                        if (this.length) {
                            this.working = true;
                            this.doNext();
                        } else {
                            this.working = false;
                        }
                    };
                    this.dequeue = function() {
                        this.length -= 1;
                        return this.list.shift();
                    };
                    this.enqueue = function(item, front = false) {
                        (front) ? this.list.unshift(item) : this.list.push(item);
                        this.length += 1;
                        if (!this.working) {
                            this.start();
                        }
                    };
                },
                createQueues: function(amount) {
                    let arr = [];
                    for (let i = 0; i < amount; i++) {
                        arr[i] = new twLib.queueLib.Queue();
                    }
                    return arr;
                },
                addItem: function(item) {
                    let leastBusyQueue = twLib.queues.map(q => q.length).reduce((next, curr) => (curr < next) ? curr : next, 0);
                    twLib.queues[leastBusyQueue].enqueue(item);
                },
                orchestrator: function(type, arg) {
                    let promise = $.Deferred();
                    let item = new twLib.queueLib.Item(type, arg, promise);
                    twLib.queueLib.addItem(item);
                    return promise;
                }
            },
            ajax: function() { return twLib.queueLib.orchestrator('ajax', arguments); },
            get:   function() { return twLib.queueLib.orchestrator('get',   arguments); },
            post:  function() { return twLib.queueLib.orchestrator('post',  arguments); },
            openWindow: function() {
                let item = new twLib.queueLib.Item('openWindow', arguments);
                twLib.queueLib.addItem(item);
            }
        };
        twLib.init();
    }

    const setUnitSpeeds = function() {
        let unitSpeeds = {};
        $.when($.get('/interface.php?func=get_unit_info')).then((xml) => {
            $(xml).find('config').children().map((i, el) => {
                unitSpeeds[$(el).prop('nodeName')] = $(el).find('speed').text().toNumber();
            });
            localStorage.setItem('FarmGod_unitSpeeds', JSON.stringify(unitSpeeds));
        });
    };

    const getUnitSpeeds = function() {
        return JSON.parse(localStorage.getItem('FarmGod_unitSpeeds')) || false;
    };

    if (!getUnitSpeeds()) setUnitSpeeds();

    const determineNextPage = function(page, $html) {
        let villageLength = ($html.find('#scavenge_mass_screen').length > 0) ? $html.find('tr[id*="scavenge_village"]').length : $html.find('tr.row_a, tr.row_ax, tr.row_b, tr.row_bx').length;
        let navSelect = $html.find('.paged-nav-item').first().closest('td').find('select').first();
        let navLength = ($html.find('#am_widget_Farm').length > 0) ? parseInt($('#plunder_list_nav').first().find('a.paged-nav-item, strong.paged-nav-item')[$('#plunder_list_nav').first().find('a.paged-nav-item, strong.paged-nav-item').length - 1].textContent.replace(/\D/g, '')) - 1 : ((navSelect.length > 0) ? navSelect.find('option').length - 1 : $html.find('.paged-nav-item').not('[href*="page=-1"]').length);
        let pageSize = ($('#mobileHeader').length > 0) ? 10 : parseInt($html.find('input[name="page_size"]').val());
        if (page == -1 && villageLength == 1000) {
            return Math.floor(1000 / pageSize);
        } else if (page < navLength) {
            return page + 1;
        }
        return false;
    };

    const processPage = function(url, page, wrapFn) {
        let pageText = (url.match('am_farm')) ? `&Farm_page=${page}` : `&page=${page}`;
        return twLib.ajax({ url: url + pageText }).then((html) => {
            return wrapFn(page, $(html));
        });
    };

    const processAllPages = function(url, processorFn) {
        let page = (url.match('am_farm') || url.match('scavenge_mass')) ? 0 : -1;
        let wrapFn = function(page, $html) {
            let dnp = determineNextPage(page, $html);
            if (dnp) {
                processorFn($html);
                return processPage(url, dnp, wrapFn);
            } else {
                return processorFn($html);
            }
        };
        return processPage(url, page, wrapFn);
    };

    const getDistance = function(origin, target) {
        let a = origin.toCoord(true).x - target.toCoord(true).x;
        let b = origin.toCoord(true).y - target.toCoord(true).y;
        return Math.hypot(a, b);
    };

    const subtractArrays = function(array1, array2) {
        let result = array1.map((val, i) => val - array2[i]);
        return (result.some(v => v < 0)) ? false : result;
    };

    const getCurrentServerTime = function() {
        let [hour, min, sec, day, month, year] = $('#serverTime').closest('p').text().match(/\d+/g);
        return new Date(year, (month - 1), day, hour, min, sec).getTime();
    };

    const timestampFromString = function(timestr) {
        let d = $('#serverDate').text().split('/').map(x => +x);
        let todayPattern = new RegExp(window.lang['aea2b0aa9ae1534226518faaefffdaad'].replace('%s', '([\\d+|:]+)')).exec(timestr);
        let tomorrowPattern = new RegExp(window.lang['57d28d1b211fddbb7a499ead5bf23079'].replace('%s', '([\\d+|:]+)')).exec(timestr);
        let laterDatePattern = new RegExp(window.lang['0cb274c906d622fa8ce524bcfbb7552d'].replace('%1', '([\\d+|\\.]+)').replace('%2', '([\\d+|:]+)')).exec(timestr);
        let t, date;
        if (todayPattern !== null) {
            t = todayPattern[1].split(':');
            date = new Date(d[2], (d[1] - 1), d[0], t[0], t[1], t[2], (t[3] || 0));
        } else if (tomorrowPattern !== null) {
            t = tomorrowPattern[1].split(':');
            date = new Date(d[2], (d[1] - 1), (d[0] + 1), t[0], t[1], t[2], (t[3] || 0));
        } else {
            d = (laterDatePattern[1] + d[2]).split('.').map(x => +x);
            t = laterDatePattern[2].split(':');
            date = new Date(d[2], (d[1] - 1), d[0], t[0], t[1], t[2], (t[3] || 0));
        }
        return date.getTime();
    };

    String.prototype.toCoord = function(objectified) {
        let c = (this.match(/\d{1,3}\|\d{1,3}/g) || [false]).pop();
        return (c && objectified) ? {x: c.split('|')[0], y: c.split('|')[1]} : c;
    };

    String.prototype.toNumber = function() { return parseFloat(this); };
    Number.prototype.toNumber  = function() { return parseFloat(this); };

    return {
        getUnitSpeeds,
        processPage,
        processAllPages,
        getDistance,
        subtractArrays,
        getCurrentServerTime,
        timestampFromString
    };
})();

window.FarmGod.Translation = (function() {
    const msg = {
        sk_SK: {
            missingFeatures: 'Skript vyžaduje PU a FA!',
            options: {
                title: 'FarmGod Nastavenia',
                warning: `<b>Upozornenie:</b><br>- Do rabovania idú len ZELENÉ ciele (žltá/červená/modrá sa ignoruje)<br>- Pred použitím skriptu vypnite filtre vo Farm Assistante (skryté dediny by sa mohli pridať späť ako zelené)`,
                filterImage: 'https://scripts.cybermine.cz/farmgod.png',
                group: 'Poslať farmy zo skupiny:',
                distance: 'Max vzdialenosť:',
                time: 'Min čas v min medzi farmami:',
                limitPoints: 'Iba barbarky do:',
                findNewBarbs: 'Nájsť nové barbarky',
                useBlacklist: 'Použiť blacklist z poznámok',
                ramEnabled: `Plánovať útoky s baranidlami (červené ciele)`,
                ramDistance: 'Baranidlá – max vzdialenosť:',
                autoEnabled: 'Automatický režim (opakuje a posiela sám):',
                autoInterval: 'Interval medzi cyklami (min – max):',
                button: 'Plánovať farmy'
            },
            table: {
                noFarmsPlanned: `Žiadne farmy nemôžu byť poslané s aktuálnym nastavením.`,
                origin: 'Pôvod',
                target: 'Cieľ',
                points: 'Body',
                fields: 'Vzdialenosť',
                farm: 'Vzor',
                goTo: 'Ísť do',
                sendAll: 'BLITZKRIEG',
                loading: 'Načítavam...'
            },
            messages: {
                villageChanged: 'Úspešne zmenená dedina!',
                villageError: `Všetky farmy pre súčasnú dedinu boli odoslané!`,
                sendError: 'Error: Farma neposlaná!'
            }
        }
    };
    const get = function() {
        let lang = (msg.hasOwnProperty(game_data.locale)) ? game_data.locale : 'sk_SK';
        return msg[lang];
    };
    return { get };
})();

window.FarmGod.Main = (function(Library, Translation) {
    const lib = Library;
    const t = Translation.get();
    let curVillage = null;
    let farmBusy = false;

    // ====== KONFIGURÁCIA ÚTOKOV S BARANIDLAMI ======
    // Kľúč = level múru. Levely, ktoré tu nie sú (0, 3+, neznámy), skript neplánuje – iba ich vypíše ako "manuálne".
    const RAM_PLANS = {
        1: { light: 5,  spy: 1, ram: 4 },
        2: { light: 10, spy: 1, ram: 8 }
    };
    const RAM_TARGET_COLORS = ['red', 'red_blue'];   // farby, ktoré idú do tabuľky s baranidlami
    const RAM_REGISTRY_KEY  = 'FarmGod_ramSent';      // localStorage: coord -> čas dopadu (s)
    const RAM_ARRIVAL_MARGIN = 120;                   // s po dopade, kým sa ešte berie ako "letí"

    const loadRamRegistry = () => {
        try {
            let reg = JSON.parse(localStorage.getItem(RAM_REGISTRY_KEY)) || {};
            let now = Math.round(lib.getCurrentServerTime() / 1000);
            Object.keys(reg).forEach(c => { if (reg[c] + RAM_ARRIVAL_MARGIN < now) delete reg[c]; });
            return reg;
        } catch (e) {
            return {};
        }
    };

    const saveRamRegistry = (coord, arrival) => {
        let reg = loadRamRegistry();
        reg[coord] = arrival;
        localStorage.setItem(RAM_REGISTRY_KEY, JSON.stringify(reg));
    };

    const fmtDuration = (sec) => {
        let h = Math.floor(sec / 3600);
        let m = Math.floor((sec % 3600) / 60);
        return `${h}h ${String(m).padStart(2, '0')}m`;
    };

    const loadBlacklist = async () => {
        let blacklist = new Set();
        try {
            console.log("[FarmGod] Načítavam blacklist z poznámok...");
            const memoHtml = await twLib.get(game_data.link_base_pure + 'memo');
            const coordRegex = /\b(\d{1,3})\s*[\|\|]\s*(\d{1,3})\b/g;
            let match;
            while ((match = coordRegex.exec(memoHtml)) !== null) {
                const x = match[1];
                const y = match[2];
                if (x >= 0 && x <= 999 && y >= 0 && y <= 999) {
                    const coord = `${x}|${y}`;
                    blacklist.add(coord);
                }
            }
            console.log(`[FarmGod] Načítaných ${blacklist.size} súradníc do blacklistu`);
            return blacklist;
        } catch (e) {
            console.warn(`[FarmGod] Nepodarilo sa načítať poznámky → blacklist nebude použitý`, e);
            return blacklist;
        }
    };

    // ====== AUTOMATICKÝ REŽIM ======
    // RELOAD_PAGE = false: cyklus beží v tej istej stránke (všetky dáta sa ťahajú zo servera cez ajax, takže netreba reload;
    //                      funguje aj zo záložky/konzoly).
    // RELOAD_PAGE = true : po každom cykle location.reload(). Script sa po reloade znova spustí LEN ak je nainštalovaný
    //                      ako Tampermonkey userscript (hlavička hore). Zo záložky by sa reloadom stratil.
    const RELOAD_PAGE = false;
    const AUTO_KEY = 'FarmGod_auto';
    const SEND_TIMEOUT_MS = 10 * 60 * 1000;   // poistka: jedno odosielanie max 10 min
    const MAX_SEND_ERRORS = 5;                // toľko chýb po sebe = zastav (session / bot ochrana)
    let autoTimer = null, countdownTimer = null;
    let autoActive = false, abortSend = false, sendErrors = 0, cycleErrors = 0;

    const DEFAULT_OPTIONS = {
        optionGroup: 0, optionDistance: 25, optionTime: 10,
        limitPoints: true, maxPoints: 87,
        findNewBarbs: true, useBlacklist: true,
        ramEnabled: true, ramDistance: 15,
        autoEnabled: false, autoMin: 10, autoMax: 15
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const readOptions = () => Object.assign({}, DEFAULT_OPTIONS, JSON.parse(localStorage.getItem('farmGod_options')) || {});

    const botProtectionPresent = () => $(`#bot_check, .bot-protection-row, #botprotection_quest`).length > 0;

    const setStatus = (txt) => { $('#farmGodAutoStatus').text(txt); };

    const renderAutoPanel = function() {
        if ($('#farmGodAuto').length) return;
        $('body').append(`<div id="farmGodAuto" style="position:fixed;right:10px;bottom:10px;z-index:99999;background:#f4e4bc;border:1px solid #7d510f;padding:6px 10px;font-size:11px;min-width:190px;">
            <b>FarmGod – auto</b><br><span id="farmGodAutoStatus">…</span><br>
            <input type="button" class="btn" id="farmGodAutoStop" value="STOP" style="margin-top:4px;"></div>`);
        $('#farmGodAutoStop').on('click', () => stopAuto('Zastavené ručne.', true));
    };

    const stopAuto = function(msg, quiet) {
        autoActive = false;
        abortSend = true;
        clearInterval(countdownTimer);
        clearTimeout(autoTimer);
        localStorage.setItem(AUTO_KEY, JSON.stringify({ enabled: false }));
        setStatus(msg || 'Zastavené.');
        if (msg && !quiet) UI.ErrorMessage(msg);
    };

    // načíta dáta, naplánuje a vykreslí tabuľky (rovnaké ako pri ručnom spustení)
    const runPlanning = function(o) {
        return getData(o.optionGroup, o.findNewBarbs, o.useBlacklist, o.ramEnabled).then((data) => {
            try { Dialog.close(); } catch (e) {}
            // baranidlá sa plánujú PRVÉ, aby si rezervovali jednotky (LK + špeh) pred rabovaním
            let ramPlan = o.ramEnabled
                ? createRamPlanning(o.ramDistance, o.limitPoints, o.maxPoints, data)
                : { planned: [], skipped: [] };
            let plan = createPlanning(o.optionDistance, o.optionTime, o.limitPoints, o.maxPoints, data);
            $('.farmGodContent').remove();
            $('#am_widget_Farm').first().before(buildRamTable(ramPlan, o.ramEnabled) + buildTable(plan.farms, data));
            bindEventHandlers();
            UI.InitProgressBars();
            UI.updateProgressBar($('#FarmGodProgessbar'), 0, plan.counter);
            $('#FarmGodProgessbar').data('current', 0).data('max', plan.counter);
            return { ramPlan, plan };
        });
    };

    // to isté čo tlačidlo BLITZKRIEG: najprv baranidlá, potom rabovanie
    const sendAll = async function() {
        abortSend = false;
        let started = Date.now();
        let rams = document.getElementsByClassName('farmGod_ramSend');
        while (rams.length > 0 && !abortSend) {
            await sendRam($(rams[0]));
            await sleep(400);
            if (Date.now() - started > SEND_TIMEOUT_MS) break;
            if (sendErrors >= MAX_SEND_ERRORS) break;
        }
        let buttons = document.getElementsByClassName('farmGod_icon');
        while (buttons.length > 0 && !abortSend) {
            buttons[0].click();
            await sleep(200);
            if (Date.now() - started > SEND_TIMEOUT_MS) break;
            if (sendErrors >= MAX_SEND_ERRORS) break;
        }
        if (sendErrors >= MAX_SEND_ERRORS) {
            if (autoActive) stopAuto(`Príliš veľa chýb pri odosielaní (vypršané prihlásenie alebo bot ochrana?). Auto režim vypnutý.`);
            sendErrors = 0;
        }
    };

    const scheduleNext = function(o) {
        let delayMs = Math.round((o.autoMin + Math.random() * (o.autoMax - o.autoMin)) * 60000);
        let target = Date.now() + delayMs;
        clearInterval(countdownTimer);
        clearTimeout(autoTimer);
        countdownTimer = setInterval(() => {
            let left = Math.max(0, Math.round((target - Date.now()) / 1000));
            setStatus(`Ďalší cyklus o ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
        }, 1000);
        autoTimer = setTimeout(() => {
            clearInterval(countdownTimer);
            if (!autoActive) return;
            if (RELOAD_PAGE) location.reload(); else autoCycle(o);
        }, delayMs);
    };

    const autoCycle = async function(o) {
        if (!autoActive) return;
        if (botProtectionPresent()) return stopAuto(`Bot ochrana – potvrď captchu. Auto režim vypnutý.`);
        setStatus('Načítavam dáta a plánujem…');
        try {
            await runPlanning(o);
            cycleErrors = 0;
        } catch (e) {
            console.error('[FarmGod] chyba cyklu', e);
            cycleErrors++;
            if (cycleErrors >= 2) return stopAuto(`Opakovaná chyba pri načítaní dát. Auto režim vypnutý.`);
            return scheduleNext(o);
        }
        if (!autoActive) return;
        setStatus('Posielam útoky…');
        await sendAll();
        if (!autoActive) return;
        if (botProtectionPresent()) return stopAuto(`Bot ochrana – potvrď captchu. Auto režim vypnutý.`);
        scheduleNext(o);
    };

    const startAuto = function(o) {
        autoActive = true;
        abortSend = false;
        cycleErrors = 0;
        sendErrors = 0;
        if (RELOAD_PAGE) localStorage.setItem(AUTO_KEY, JSON.stringify({ enabled: true }));
        renderAutoPanel();
        autoCycle(o);
    };

    const init = function() {
        if (!game_data.features.Premium.active || !game_data.features.FarmAssistent.active) {
            UI.ErrorMessage(t.missingFeatures);
            return;
        }
        if (game_data.screen !== 'am_farm') {
            location.href = game_data.link_base_pure + 'am_farm';
            return;
        }

        // userscript režim: po reloade pokračuje auto bez dialógu
        if (RELOAD_PAGE && (JSON.parse(localStorage.getItem(AUTO_KEY)) || {}).enabled) {
            renderAutoPanel();
            setStatus('Štart o 3 s…');
            setTimeout(() => startAuto(readOptions()), 3000);
            return;
        }

        $.when(buildOptions()).then((html) => {
            Dialog.show('FarmGod', html);
            $('.optionButton').off('click').on('click', () => {
                let o = {
                    optionGroup:    parseInt($('.optionGroup').val()),
                    optionDistance: parseFloat($('.optionDistance').val()) || 25,
                    optionTime:     parseFloat($('.optionTime').val()) || 10,
                    limitPoints:    $('.optionLimitPoints').prop('checked'),
                    maxPoints:      parseInt($('.optionMaxPoints').val()) || 87,
                    findNewBarbs:   $('.optionFindNewBarbs').prop('checked'),
                    useBlacklist:   $('.optionUseBlacklist').prop('checked'),
                    ramEnabled:     $('.optionRams').prop('checked'),
                    ramDistance:    parseFloat($('.optionRamDistance').val()) || 15,
                    autoEnabled:    $('.optionAuto').prop('checked'),
                    autoMin:        parseFloat($('.optionAutoMin').val()) || 10,
                    autoMax:        parseFloat($('.optionAutoMax').val()) || 15
                };
                if (o.autoMax < o.autoMin) { let tmp = o.autoMin; o.autoMin = o.autoMax; o.autoMax = tmp; }
                localStorage.setItem('farmGod_options', JSON.stringify(o));

                $('.optionTitle').html(t.table.loading);
                $('.optionsContent').html(UI.Throbber[0].outerHTML + '<br><br>');

                if (o.autoEnabled) {
                    startAuto(o);
                    return;
                }
                runPlanning(o).catch(err => {
                    console.error("Chyba pri plánovaní farmy:", err);
                    UI.ErrorMessage("Nastala chyba pri načítaní/plánovaní dát.");
                });
            });
        });
    };

    const bindEventHandlers = function() {
        $('.farmGod_icon').off('click').on('click', function() {
            if (game_data.market != 'nl' || $(this).data('origin') == curVillage) {
                sendFarm($(this));
            } else {
                UI.ErrorMessage(t.messages.villageError);
            }
        });
        $('.farmGod_ramSend').off('click').on('click', function(e) {
            e.preventDefault();
            sendRam($(this));
        });
        $(document).off('keydown').on('keydown', (event) => {
            if (event.keyCode === 13) $('.farmGod_icon').first().trigger('click');
        });
        $('.switchVillage').off('click').on('click', function() {
            curVillage = $(this).data('id');
            UI.SuccessMessage(t.messages.villageChanged);
            $(this).closest('tr').remove();
        });
    };

    const buildOptions = function() {
        let defaults = DEFAULT_OPTIONS;
        let options = Object.assign({}, defaults, JSON.parse(localStorage.getItem('farmGod_options')) || {});
        return $.when(buildGroupSelect(options.optionGroup)).then((groupSelect) => {
            return `<style>#popup_box_FarmGod{text-align:center;width:580px;}</style>
<h3 class="optionTitle">${t.options.title}</h3><br>
<div class="optionsContent">
<div class="info_box" style="line-height:15px;font-size:10px;text-align:left;">
<p style="margin:0 5px;">${t.options.warning}<br><img src="${t.options.filterImage}" style="width:100%;"></p>
</div><br>
<div style="width:90%;margin:auto;background:url('graphic/index/main_bg.jpg') 100% 0% #E3D5B3;border:1px solid #7D510F;">
<table class="vis" style="width:100%;text-align:left;font-size:11px;">
    <tr><td>${t.options.group}</td><td>${groupSelect}</td></tr>
    <tr><td>${t.options.distance}</td><td><input type="text" size="5" class="optionDistance" value="${options.optionDistance}"></td></tr>
    <tr><td>${t.options.time}</td><td><input type="text" size="5" class="optionTime" value="${options.optionTime}"></td></tr>
    <tr>
        <td>${t.options.limitPoints}</td>
        <td>
            <input type="checkbox" class="optionLimitPoints" ${options.limitPoints?'checked':''}>
            <input type="number" min="1" class="optionMaxPoints" value="${options.maxPoints}" style="width:80px;"> bodov
        </td>
    </tr>
    <tr>
        <td>${t.options.findNewBarbs}</td>
        <td><input type="checkbox" class="optionFindNewBarbs" ${options.findNewBarbs?'checked':''}></td>
    </tr>
    <tr>
        <td>${t.options.useBlacklist}</td>
        <td><input type="checkbox" class="optionUseBlacklist" ${options.useBlacklist?'checked':''}></td>
    </tr>
    <tr>
        <td>${t.options.ramEnabled}</td>
        <td><input type="checkbox" class="optionRams" ${options.ramEnabled?'checked':''}></td>
    </tr>
    <tr>
        <td>${t.options.ramDistance}</td>
        <td><input type="text" size="5" class="optionRamDistance" value="${options.ramDistance}"></td>
    </tr>
    <tr>
        <td>${t.options.autoEnabled}</td>
        <td><input type="checkbox" class="optionAuto" ${options.autoEnabled?'checked':''}></td>
    </tr>
    <tr>
        <td>${t.options.autoInterval}</td>
        <td><input type="text" size="3" class="optionAutoMin" value="${options.autoMin}"> – <input type="text" size="3" class="optionAutoMax" value="${options.autoMax}"> min</td>
    </tr>
</table>
</div><br>
<p><b>Rabovanie A aj B:</b> iba zelené barbarky (+ limit bodov, blacklist)<br><b>Červené / červeno-modré:</b> útok s baranidlami podľa múru (1 alebo 2), potom po zelenom reporte rabovanie. Ak je múr „?“, dedina sa preskočí.</p><br>
<input type="button" class="btn optionButton" value="${t.options.button}">
</div>`;
        });
    };

    const buildGroupSelect = function(id) {
        return $.get(TribalWars.buildURL('GET', 'groups', {'ajax': 'load_group_menu'})).then((groups) => {
            let html = `<select class="optionGroup">`;
            groups.result.forEach((val) => {
                if (val.type == 'separator') {
                    html += `<option disabled=""/>`;
                } else {
                    html += `<option value="${val.group_id}" ${val.group_id == id ? 'selected' : ''}>${val.name}</option>`;
                }
            });
            html += `</select>`;
            return html;
        });
    };

    // village.txt sa stiahne len raz na jedno plánovanie
    const getVillageTxt = function(data) {
        if (!data.villageTxt) data.villageTxt = twLib.get('/map/village.txt');
        return data.villageTxt;
    };

    const loadVillagePoints = function(data) {
        return getVillageTxt(data).then((txt) => {
            let pts = {};
            txt.match(/[^\r\n]+/g)?.forEach(line => {
                let parts = line.split(',');
                if (parts.length < 6) return;
                let [id, name, x, y, player_id, points] = parts;
                if (player_id === '0') pts[`${x}|${y}`] = parseInt(points, 10) || 0;
            });
            Object.keys(data.farms.farms).forEach(c => {
                if (pts[c] !== undefined) data.farms.farms[c].points = pts[c];
            });
            data.redTargets.forEach(tg => {
                if (pts[tg.coord] !== undefined) tg.points = pts[tg.coord];
            });
            return data;
        }).catch(err => {
            console.warn(`Nepodarilo sa načítať /map/village.txt → body barbariek budú chýbať`, err);
            return data;
        });
    };

    const buildTable = function(plan, data) {
        let html = `<div class="vis farmGodContent"><h4>FarmGod</h4>
            <table class="vis" width="100%">
            <tr><div id="FarmGodProgessbar" class="progress-bar live-progress-bar progress-bar-alive" style="width:98%;margin:5px auto;"><div style="background:rgb(146,194,0);"></div><span class="label" style="margin-top:0px;"></span></div></tr>`;
        if (game_data.market == 'sk')
            html += `<tr><td colspan="5" style="background:#e7d098;"><input type="button" class="btn" value="${t.table.sendAll}" style="width:100%;" onclick="SHIT()"></td></tr>`;
        html += `<tr>
            <th style="text-align:center;">${t.table.origin}</th>
            <th style="text-align:center;">${t.table.target}</th>
            <th style="text-align:center;">${t.table.points}</th>
            <th style="text-align:center;">${t.table.fields}</th>
            <th style="text-align:center;">${t.table.farm}</th>
        </tr>`;
        if (!$.isEmptyObject(plan)) {
            for (let originCoord in plan) {
                if (game_data.market == 'nl')
                    html += `<tr><td colspan="5" style="background:#e7d098;"><input type="button" class="btn switchVillage" data-id="${plan[originCoord][0].origin.id}" value="${t.table.goTo} ${plan[originCoord][0].origin.name} (${plan[originCoord][0].origin.coord})" style="float:right;"></td></tr>`;
                plan[originCoord].forEach((val, i) => {
                    let pointsDisplay = (val.target.points !== undefined) ? val.target.points.toLocaleString('sk-SK') : '?';
                    html += `<tr class="farmRow row_${(i%2==0)?'a':'b'}">
                        <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${val.origin.id}">${val.origin.name} (${val.origin.coord})</a></td>
                        <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${val.target.id}">Dedina barbarov (${val.target.coord})</a></td>
                        <td style="text-align:center;font-weight:bold;">${pointsDisplay}</td>
                        <td style="text-align:center;">${val.fields.toFixed(2)}</td>
                        <td style="text-align:center;"><a href="#" data-origin="${val.origin.id}" data-target="${val.target.id}" data-template="${val.template.id}" class="farmGod_icon farm_icon farm_icon_${val.template.name}" style="margin:auto;"></a></td>
                    </tr>`;
                });
            }
        } else {
            html += `<tr><td colspan="5" style="text-align:center;">${t.table.noFarmsPlanned}</td></tr>`;
        }
        html += `</table></div>`;
        return html;
    };

    // ====== TABUĽKA: červené ciele + útok s baranidlami ======
    const buildRamTable = function(ramPlan, enabled) {
        if (!enabled) return '';
        let html = `<div class="vis farmGodContent"><h4>FarmGod – baranidlá na červené ciele</h4>
            <table class="vis" width="100%">
            <tr>
                <th style="text-align:center;">Pôvod</th>
                <th style="text-align:center;">Cieľ</th>
                <th style="text-align:center;">Múr</th>
                <th style="text-align:center;">Body</th>
                <th style="text-align:center;">Vzdialenosť</th>
                <th style="text-align:center;">Cesta</th>
                <th style="text-align:center;">Jednotky</th>
                <th style="text-align:center;">Akcia</th>
            </tr>`;
        let unknownCount = ramPlan.skipped.filter(s => s.unknownWall).length;
        let shownSkipped = ramPlan.skipped.filter(s => !s.unknownWall);
        if (!ramPlan.planned.length && !shownSkipped.length && !unknownCount) {
            html += `<tr><td colspan="8" style="text-align:center;">Žiadne červené ciele v dosahu.</td></tr>`;
        }
        ramPlan.planned.forEach((r, i) => {
            html += `<tr class="row_${(i%2==0)?'a':'b'}">
                <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${r.origin.id}">${r.origin.name} (${r.origin.coord})</a></td>
                <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${r.target.id}">Dedina barbarov (${r.target.coord})</a> <span style="color:#a00;">[${r.target.color}]</span></td>
                <td style="text-align:center;font-weight:bold;">${r.target.wall}</td>
                <td style="text-align:center;">${r.target.points !== undefined ? r.target.points.toLocaleString('sk-SK') : '?'}</td>
                <td style="text-align:center;">${r.fields.toFixed(2)}</td>
                <td style="text-align:center;">${fmtDuration(r.eta)}</td>
                <td style="text-align:center;">${r.units.light} LK + ${r.units.spy} špeh + ${r.units.ram} baranidlá</td>
                <td style="text-align:center;"><input type="button" class="btn farmGod_ramSend" value="Poslať"
                    data-origin="${r.origin.id}" data-coord="${r.target.coord}"
                    data-light="${r.units.light}" data-spy="${r.units.spy}" data-ram="${r.units.ram}"
                    data-eta="${r.eta}">
                    <a href="/game.php?village=${r.origin.id}&screen=place&target=${r.target.id}" target="_blank" title="Otvoriť nádvorie">&#8599;</a></td>
            </tr>`;
        });
        shownSkipped.forEach((s) => {
            html += `<tr style="opacity:0.7;">
                <td style="text-align:center;">—</td>
                <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${s.target.id}">Dedina barbarov (${s.target.coord})</a> <span style="color:#a00;">[${s.target.color}]</span></td>
                <td style="text-align:center;">${isNaN(s.target.wall) ? '?' : s.target.wall}</td>
                <td style="text-align:center;">${s.target.points !== undefined ? s.target.points.toLocaleString('sk-SK') : '?'}</td>
                <td colspan="4" style="text-align:left;">${s.reason}</td>
            </tr>`;
        });
        if (unknownCount) {
            html += `<tr><td colspan="8" style="text-align:left;opacity:0.8;">Preskočených ${unknownCount} červených / červeno-modrých cieľov v dosahu s neznámym múrom (?).</td></tr>`;
        }
        html += `</table></div>`;
        return html;
    };

    const getData = async function(group, findNewBarbs, useBlacklist, planRams) {
        let data = {
            villages: {}, commands: {}, commandIds: {}, ramCommandState: {},
            farms: { templates: {}, farms: {} },
            redTargets: [], blacklist: new Set(), unitNames: [], villageTxt: null
        };

        if (useBlacklist) {
            data.blacklist = await loadBlacklist();
        } else {
            console.log("[FarmGod] Blacklist vypnutý v nastaveniach");
        }

        const skipUnits = ['ram', 'catapult', 'snob', 'militia'];
        data.unitNames = game_data.units.filter(u => !skipUnits.includes(u));

        const villagesProcessor = ($html) => {
            if ($('#mobileHeader').length) {
                $html.find(`.overview-container .overview-container-item`).filter((i, el) => !$(el).find('.bonus_icon_33').length).each(function() {
                    let $el = $(this);
                    let $qel = $el.find('.quickedit-label').first();
                    let units = [];
                    let all = {};
                    game_data.units.forEach((unit, idx) => {
                        let $img = $el.find(`img[src*="unit/unit_${unit}"]`);
                        all[unit] = $img.length ? $img.next().text().toNumber() : 0;
                        if (skipUnits.includes(unit)) return;
                        units.push(all[unit]);
                    });
                    data.villages[$qel.text().toCoord()] = {
                        name: $qel.data('text'),
                        id: parseInt($el.find('.quickedit-vn').first().data('id')),
                        units: units,
                        all: all
                    };
                });
            } else {
                $html.find(`#combined_table .row_a, #combined_table .row_b`).filter((i, el) => !$(el).find('.bonus_icon_33').length).each(function() {
                    let $el = $(this);
                    let $qel = $el.find('.quickedit-label').first();
                    let units = $el.find('.unit-item').filter((idx) => !skipUnits.includes(game_data.units[idx])).map((idx, el) => $(el).text().toNumber()).get();
                    let all = {};
                    $el.find('.unit-item').each((idx, cell) => { all[game_data.units[idx]] = $(cell).text().toNumber(); });
                    data.villages[$qel.text().toCoord()] = {
                        name: $qel.data('text'),
                        id: parseInt($el.find('.quickedit-vn').first().data('id')),
                        units: units,
                        all: all
                    };
                });
            }
        };

        const commandsProcessor = ($html) => {
            $html.find(`#commands_table .row_a, #commands_table .row_ax, #commands_table .row_b, #commands_table .row_bx`).each(function() {
                let $el = $(this);
                let coord = $el.find('.quickedit-label').first().text().toCoord();
                if (coord) {
                    if (!data.commands[coord]) data.commands[coord] = [];
                    data.commands[coord].push(Math.round(lib.timestampFromString($el.find('td').eq(2).text().trim()) / 1000));
                    let cid = ($el.find('a[href*="info_command"]').first().attr('href') || '').match(/[?&]id=(\d+)/)?.[1];
                    if (cid) {
                        if (!data.commandIds[coord]) data.commandIds[coord] = [];
                        data.commandIds[coord].push(cid);
                    }
                }
            });
        };

        const farmProcessor = ($html) => {
            if ($.isEmptyObject(data.farms.templates)) {
                let unitSpeeds = lib.getUnitSpeeds();
                $html.find(`form[action*="action=edit_all"] tr:has(input[name*="template"][type="hidden"])`).each(function() {
                    let $el = $(this);
                    let name = $el.prev('tr').find('a.farm_icon').first().attr('class')?.match(/farm_icon_(\w+)/)?.[1];
                    if (!name) return;
                    data.farms.templates[name] = {
                        id: $el.find('input[name*="template"][name*="[id]"]').first().val().toNumber(),
                        units: data.unitNames.map(u => {
                            let $inp = $el.find(`input[name^="${u}["]`).first();
                            return $inp.length ? ($inp.val().toNumber() || 0) : 0;
                        }),
                        speed: Math.max(...$el.find('input[type="text"], input[type="number"]').map((_, el) => {
                            let val = $(el).val().toNumber();
                            return (val > 0) ? (unitSpeeds[$(el).attr('name').trim().split('[')[0]] || 0) : 0;
                        }).get())
                    };
                });
            }

            // stĺpec s levelom múru = <th> s ikonou múru v hlavičke tabuľky FA
            let wallIdx = -1;
            $html.find('#plunder_list tr').first().find('th').each((i, th) => {
                if ($(th).find('img[src*="buildings/wall"]').length) wallIdx = i;
            });
            if (wallIdx < 0) console.warn(`[FarmGod] Stĺpec s múrom sa nenašiel – červené ciele budú mať múr "?"`);

            // načíta VŠETKY barbarky z plunder_list aj s farbou a múrom (filtrovanie farieb je až v filterFarms)
            $html.find('#plunder_list tr[id^="village_"]').each(function() {
                let $el = $(this);
                let coord = $el.find('a[href*="screen=report&mode=all&view="]').first().text().toCoord();
                if (!coord) return;

                let colorMatch = $el.find('img[src*="graphic/dots/"]').attr('src')?.match(/dots\/([a-z_]+)\.(?:png|webp|gif)/);
                let color = colorMatch ? colorMatch[1] : "green";

                let wall = NaN;
                if (wallIdx >= 0) {
                    let txt = $el.find('td').eq(wallIdx).text().trim();
                    if (/^\d+$/.test(txt)) wall = parseInt(txt, 10);
                }

                data.farms.farms[coord] = {
                    id: $el.attr('id').split('_')[1].toNumber(),
                    color: color,
                    wall: wall
                };
            });
        };

        // Nové barbarky: pridávajú sa až PO načítaní am_farm a len tie, ktoré FA vôbec nepozná
        const addNewBarbsRespectingColors = () => {
            return getVillageTxt(data).then(txt => {
                let added = 0;
                txt.match(/[^\r\n]+/g)?.forEach(line => {
                    let [id, , x, y, player_id] = line.split(',');
                    if (player_id !== '0') return;
                    let coord = `${x}|${y}`;
                    if (data.farms.farms[coord]) return;   // FA ju pozná → nikdy ju neprepisuj
                    data.farms.farms[coord] = { id: parseInt(id, 10), color: 'green', wall: NaN };
                    added++;
                });
                console.log(`[FarmGod] Pridaných ${added} nových barbariek`);
                return data;
            });
        };

        // WHITELIST: do rabovania ide LEN zelená. Červené a červeno-modré idú do zoznamu pre baranidlá.
        const filterFarms = () => {
            let entries = Object.entries(data.farms.farms);
            data.redTargets = entries
                .filter(([_, v]) => RAM_TARGET_COLORS.includes(v.color))
                .map(([coord, v]) => Object.assign({ coord }, v));
            // rabuje sa: zelená, ALEBO modrá (len prieskum) so ZNÁMYM múrom 0 (bez múru netreba baranidlá)
            data.farms.farms = Object.fromEntries(entries.filter(([_, v]) =>
                v.color === 'green' || (v.color === 'blue' && v.wall === 0)));
            return data;
        };

        // Zistí, či k červenému cieľu už letí náš útok s baranidlami (cez info_command).
        // 'ram' = letí, 'noram' = letia iba iné útoky, 'unknown' = nepodarilo sa overiť (cieľ sa radšej preskočí)
        const detectRamCommands = async () => {
            if (!planRams) return data;
            for (const target of data.redTargets) {
                let ids = data.commandIds[target.coord];
                if (!ids || !ids.length) continue;
                let state = 'noram';
                for (const id of ids) {
                    try {
                        let html = await twLib.get(TribalWars.buildURL('GET', 'info_command', { id: id }));
                        let $h = $(html);
                        if (!$h.find('.unit-item').length) { state = 'unknown'; break; }
                        if ($h.find('.unit-item-ram').first().text().toNumber() > 0) { state = 'ram'; break; }
                    } catch (e) {
                        state = 'unknown';
                        break;
                    }
                }
                data.ramCommandState[target.coord] = state;
            }
            return data;
        };

        let promises = [
            lib.processAllPages(TribalWars.buildURL('GET', 'overview_villages', { mode: 'combined', group }), villagesProcessor),
            lib.processPage(TribalWars.buildURL('GET', 'overview_villages', { mode: 'commands', type: 'attack' }), -1, (page, $html) => commandsProcessor($html)),
            lib.processAllPages(TribalWars.buildURL('GET', 'am_farm'), farmProcessor)
        ];

        return Promise.all(promises)
            .then(() => findNewBarbs ? addNewBarbsRespectingColors() : null)
            .then(filterFarms)
            .then(() => loadVillagePoints(data))
            .then(detectRamCommands)
            .then(() => data);
    };

    // ====== PLÁNOVANIE ÚTOKOV S BARANIDLAMI ======
    const createRamPlanning = function(maxDistance, limitPoints, maxPoints, data) {
        let result = { planned: [], skipped: [] };
        let ramSpeed = (lib.getUnitSpeeds() || {}).ram || 30;
        let registry = loadRamRegistry();
        let idxLight = data.unitNames.indexOf('light');
        let idxSpy   = data.unitNames.indexOf('spy');

        data.redTargets.forEach(target => {
            if (data.blacklist.size > 0 && data.blacklist.has(target.coord)) return;
            if (limitPoints && (target.points ?? 999999) >= maxPoints) return;

            let candidates = Object.keys(data.villages)
                .map(o => ({ origin: o, dis: lib.getDistance(o, target.coord) }))
                .filter(c => c.dis < maxDistance)
                .sort((a, b) => a.dis - b.dis);
            if (!candidates.length) return;   // mimo dosahu – nezobrazuj

            if (registry[target.coord]) {
                result.skipped.push({ target, reason: `Útok s baranidlami (poslaný týmto skriptom) už letí.` });
                return;
            }
            let state = data.ramCommandState[target.coord];
            if (state === 'ram') {
                result.skipped.push({ target, reason: 'Útok s baranidlami už letí.' });
                return;
            }
            if (state === 'unknown') {
                result.skipped.push({ target, reason: `Neviem overiť, či tam letia baranidlá – skontroluj ručne.` });
                return;
            }
            // múr neznámy ("?") -> radšej nejdeme (nevieme, čo tam je); plánujeme len pri známom múre s definovaným vzorom
            if (isNaN(target.wall)) {
                result.skipped.push({ target, unknownWall: true, reason: 'Múr neznámy (?) – preskočené.' });
                return;
            }
            let plan = RAM_PLANS[target.wall];
            if (!plan) {
                result.skipped.push({ target, reason: `Múr ${target.wall} nemá definovaný vzor – manuálne.` });
                return;
            }

            let chosen = candidates.find(c => {
                let a = data.villages[c.origin].all;
                return (a.light || 0) >= plan.light && (a.spy || 0) >= plan.spy && (a.ram || 0) >= plan.ram;
            });
            if (!chosen) {
                result.skipped.push({ target, reason: `Nedostatok jednotiek v dosahu (${plan.light} LK, ${plan.spy} špeh, ${plan.ram} baranidiel).` });
                return;
            }

            let v = data.villages[chosen.origin];
            v.all.light -= plan.light;
            v.all.spy   -= plan.spy;
            v.all.ram   -= plan.ram;
            if (idxLight >= 0) v.units[idxLight] -= plan.light;   // rezervácia pre rabovanie
            if (idxSpy   >= 0) v.units[idxSpy]   -= plan.spy;

            result.planned.push({
                origin: { coord: chosen.origin, name: v.name, id: v.id },
                target: target,
                fields: chosen.dis,
                eta: Math.round(chosen.dis * ramSpeed * 60),
                units: { light: plan.light, spy: plan.spy, ram: plan.ram }
            });
        });

        result.planned.sort((a, b) => a.fields - b.fields);
        return result;
    };

    const createPlanning = function(maxDistance, minTimeDiffMin, limitPoints, maxPoints, data) {
        let plan = { counter: 0, farms: {} };
        let serverTime = Math.round(lib.getCurrentServerTime() / 1000);
        let minTimeDiff = Math.round(minTimeDiffMin * 60);

        for (let originCoord in data.villages) {
            let orderedFarms = Object.keys(data.farms.farms)
                .map(coord => ({ coord, dis: lib.getDistance(originCoord, coord) }))
                .sort((a, b) => a.dis - b.dis);

            orderedFarms.forEach(el => {
                let farm = data.farms.farms[el.coord];
                let points = farm.points ?? 999999;

                // BLACKLIST kontrola
                if (data.blacklist.size > 0 && data.blacklist.has(el.coord)) {
                    return;
                }

                if (limitPoints && points >= maxPoints) return;

                ['a', 'b'].forEach(tmplName => {
                    let template = data.farms.templates[tmplName];
                    if (!template) return;

                    let unitsLeft = lib.subtractArrays(data.villages[originCoord].units, template.units);
                    if (!unitsLeft) return;

                    let distance = el.dis;
                    if (distance >= maxDistance) return;

                    let arrival = Math.round(serverTime + (distance * template.speed * 60) + Math.round(plan.counter / 5));

                    data.commands[el.coord] = data.commands[el.coord] ?? [];
                    let timeOk = true;

                    for (let ts of data.commands[el.coord]) {
                        if (Math.abs(ts - arrival) < minTimeDiff) {
                            timeOk = false;
                            break;
                        }
                    }

                    if (timeOk) {
                        plan.counter++;
                        if (!plan.farms[originCoord]) plan.farms[originCoord] = [];
                        plan.farms[originCoord].push({
                            origin: { coord: originCoord, name: data.villages[originCoord].name, id: data.villages[originCoord].id },
                            target: { coord: el.coord, id: farm.id, points: points },
                            fields: distance,
                            template: { name: tmplName, id: template.id }
                        });
                        data.villages[originCoord].units = unitsLeft;
                        data.commands[el.coord].push(arrival);
                    }
                });
            });
        }
        return plan;
    };

    const sendFarm = function($this) {
        let n = Timing.getElapsedTimeSinceLoad();
        if (farmBusy || (Accountmanager.farm.last_click && n - Accountmanager.farm.last_click < 200)) return;
        farmBusy = true;
        Accountmanager.farm.last_click = n;
        let $pb = $('#FarmGodProgessbar');

        TribalWars.post(Accountmanager.send_units_link.replace(/village=(\d+)/, 'village=' + $this.data('origin')), null, {
            target: $this.data('target'),
            template_id: $this.data('template'),
            source: $this.data('origin')
        }, function(r) {
            sendErrors = 0;
            UI.SuccessMessage(r.success || "Útok odoslaný!");
            $pb.data('current', ($pb.data('current') || 0) + 1);
            UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
            $this.closest('.farmRow').remove();
            farmBusy = false;
        }, function(r) {
            sendErrors++;
            UI.ErrorMessage(r || t.messages.sendError);
            $pb.data('current', ($pb.data('current') || 0) + 1);
            UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
            $this.closest('.farmRow').remove();
            farmBusy = false;
        });
    };

    // ====== ODOSLANIE ÚTOKU S BARANIDLAMI (2 kroky ako v hre: place -> potvrdenie -> odoslanie) ======
    const sendRam = function($btn) {
        if ($btn.data('busy')) return Promise.resolve(false);
        $btn.data('busy', true);

        let originId = $btn.data('origin');
        let coord    = String($btn.data('coord'));
        let [x, y]   = coord.split('|');
        let units    = { light: $btn.data('light'), spy: $btn.data('spy'), ram: $btn.data('ram') };

        const fail = (msg) => {
            sendErrors++;
            UI.ErrorMessage(`Baranidlá ${coord}: ${msg}`);
            $btn.data('busy', false).removeClass('farmGod_ramSend').val('Chyba').prop('disabled', true);
            return false;
        };

        let payload = {
            source_village: originId,
            template_id: '',
            x: x, y: y,
            target_type: 'coord',
            input: '',
            attack: 'l',
            h: game_data.csrf
        };
        game_data.units.forEach(u => { if (u !== 'militia') payload[u] = units[u] || ''; });

        // krok 1: potvrdenie
        return $.post(`/game.php?village=${originId}&screen=place&try=confirm`, payload).then((html) => {
            let $h = $('<div>').append($.parseHTML(String(html)));
            if ($h.find('#bot_check, .bot-protection-row').length) return fail('Bot ochrana – potvrď captcha a skús znova.');
            let $form = $h.find('form[action*="action=command"]').first();
            if (!$form.length) {
                let err = $h.find('.error_box').text().trim();
                return fail(err || 'Potvrdzovací formulár sa nenašiel.');
            }
            // krok 2: odoslanie
            return $.post($form.attr('action'), $form.serialize()).then((res) => {
                let $r = $('<div>').append($.parseHTML(String(res)));
                let err = $r.find('.error_box').text().trim();
                if (err) return fail(err);

                let serverTime = Math.round(lib.getCurrentServerTime() / 1000);
                saveRamRegistry(coord, serverTime + parseInt($btn.data('eta'), 10));
                sendErrors = 0;
                UI.SuccessMessage(`Baranidlá odoslané na ${coord}`);
                $btn.closest('tr').remove();
                return true;
            });
        }).catch(() => fail('Chyba spojenia.'));
    };

    return { init, sendRam, sendAll };
})(window.FarmGod.Library, window.FarmGod.Translation);

(() => { window.FarmGod.Main.init(); })();

async function SHIT()
{
    return window.FarmGod.Main.sendAll();
};
