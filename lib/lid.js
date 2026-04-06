// lid to pn
async function lidToPhone(conn, lid) {
    try {
        const pn = await conn.signalRepository.lidMapping.getPNForLID(lid);
        if (pn) {
            return cleanPN(pn);
        }
        return lid.split("@")[0];
    } catch (e) {
        return lid.split("@")[0];
    }
}

// cleanPn
function cleanPN(pn) {
    return pn.split(":")[0];
}

// Resolve display name from JID — handles LID format
async function resolveJidDisplay(conn, jid, participants) {
    if (!jid) return 'Unknown';
    // Try to find in participants list first
    if (participants && participants.length) {
        const match = participants.find(p =>
            (p.id || '').split('@')[0].split(':')[0] === jid.split('@')[0].split(':')[0]
        );
        if (match?.name || match?.notify || match?.verifiedName) {
            return match.name || match.notify || match.verifiedName;
        }
    }
    // If LID format, resolve to phone number
    if (jid.endsWith('@lid')) {
        const phone = await lidToPhone(conn, jid);
        return phone;
    }
    return jid.split('@')[0].split(':')[0];
}

module.exports = { 
    lidToPhone, 
    cleanPN,
    resolveJidDisplay
};