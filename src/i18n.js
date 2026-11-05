// -----------------------------------------------------------------------------
// Every text shown to the user, in French and English. A text shown in the
// Configuration screen is a { en, fr } object; device and feature names follow
// the "Language of the names" option. No secret ever enters a text, nor a raw
// value typed by the user (an invalid address is quoted cut and cleaned).
// -----------------------------------------------------------------------------

const t = (fr, en) => ({ fr, en });

export const T = {
  // Configuration problems.
  noHost: t(
    'Indiquez l’adresse IP d’au moins un appareil Akuvox.',
    'Enter the IP address of at least one Akuvox device.',
  ),
  hostsInvalid: t(
    'Aucune adresse valable : indiquez des adresses IP séparées par des virgules (par ex. 192.168.1.50, 192.168.1.51:8080).',
    'No valid address: enter IP addresses separated by commas (e.g. 192.168.1.50, 192.168.1.51:8080).',
  ),
  tooManyHosts: t('8 appareils au plus.', '8 devices at most.'),
  credentialsMissing: t(
    'Indiquez l’utilisateur et le mot de passe de l’API HTTP de l’appareil, ou choisissez « Aucune » authentification.',
    'Enter the user and password of the HTTP API of the device, or choose "None" as authentication.',
  ),
  configUnreadable: (ms) =>
    t(
      `Configuration illisible depuis Gladys, nouvel essai dans ${Math.round(ms / 1000)} s.`,
      `Configuration unreadable from Gladys, trying again in ${Math.round(ms / 1000)} s.`,
    ),
  ignored: (count) =>
    t(`${count} adresse(s) ignorée(s) : invalide(s)`, `${count} address(es) ignored: invalid`),
  dataUnreadable: t(
    '/data illisible : les refus d’identifiants ne sont pas gardés après un redémarrage.',
    '/data unreadable: refused credentials are not kept across a restart.',
  ),

  // One line per device.
  starting: (host) => t(`${host} : connexion…`, `${host}: connecting…`),
  ok: (host, model, relays) =>
    t(
      `${host} : ${model}, ${relays} relais`,
      `${host}: ${model}, ${relays} relay${relays === 1 ? '' : 's'}`,
    ),
  down: (host) => t(`${host} : injoignable`, `${host}: unreachable`),
  refused: (host) =>
    t(
      `${host} : identifiants refusés, plus aucun essai ; corrigez-les ou cliquez sur « Tester la connexion »`,
      `${host}: credentials refused, no more tries; fix them or click "Test the connection"`,
    ),
  forbidden: (host) =>
    t(
      `${host} : accès refusé (403) ; autorisez l’adresse de Gladys dans l’API HTTP de l’appareil`,
      `${host}: access refused (403); allow the address of Gladys in the HTTP API of the device`,
    ),
  basicOnly: (host) =>
    t(
      `${host} : l’appareil demande l’authentification Basic alors que Digest est choisie ; rien n’a été envoyé`,
      `${host}: the device asks for Basic authentication while Digest is chosen; nothing was sent`,
    ),
  answer: (host) =>
    t(
      `${host} : réponse inattendue (est-ce bien l’API HTTP d’un Akuvox ?)`,
      `${host}: unexpected answer (is this the HTTP API of an Akuvox?)`,
    ),
  logsUnread: t('journaux non lus', 'logs not read'),
  noLogs: t('journaux non pris en charge', 'logs not supported'),
  openOff: t('ouverture désactivée', 'opening off'),
  lastCommand: (text) => t(`dernière ouverture : ${text.fr}`, `last opening: ${text.en}`),

  // Results of an opening (status and ack).
  confirmed: (letter) =>
    t(`relais ${letter} ouvert, confirmé`, `relay ${letter} opened, confirmed`),
  acceptedUnconfirmed: (letter) =>
    t(
      `relais ${letter} : accepté par l’appareil, ouverture pas encore relue`,
      `relay ${letter}: accepted by the device, opening not read back yet`,
    ),
  sentUnconfirmed: (letter) =>
    t(
      `relais ${letter} : envoyée, sans réponse de l’appareil (peut-être ouvert)`,
      `relay ${letter}: sent, no answer from the device (maybe opened)`,
    ),
  rejectedByDevice: (letter) =>
    t(`relais ${letter} : refusée par l’appareil`, `relay ${letter}: refused by the device`),
  notSent: (letter, reason) =>
    t(
      `relais ${letter} : rien envoyé (${reason.fr})`,
      `relay ${letter}: nothing sent (${reason.en})`,
    ),

  // Reasons a command is refused before anything leaves.
  openDisabled: t(
    'ouverture désactivée dans la configuration',
    'opening is off in the configuration',
  ),
  unknownDevice: t('appareil inconnu ou pas encore lu', 'unknown device, or not read yet'),
  notButton: t('cette fonctionnalité n’est pas une commande', 'this feature is not a command'),
  badValue: t('valeur inattendue', 'unexpected value'),
  credentialsRefused: t('identifiants refusés', 'credentials refused'),
  otherDevice: t(
    'un autre appareil répond à cette adresse',
    'another device answers at this address',
  ),
  identityUnreadable: t('identité de l’appareil illisible', 'identity of the device unreadable'),
  unreachable: t('appareil injoignable', 'device unreachable'),
  manualRelay: t(
    'relais en mode manuel (bistable) sur l’appareil : non pris en charge',
    'relay in manual (bistable) mode on the device: not supported',
  ),
  configNotRead: t('configuration des relais illisible', 'relay configuration unreadable'),
  unknownRelay: t('relais absent de l’appareil', 'relay not on the device'),
  queueFull: t('trop de commandes en attente', 'too many commands waiting'),
  tooLate: t('délai dépassé avant l’envoi', 'deadline passed before sending'),
  stopped: t('intégration arrêtée ou reconfigurée', 'integration stopped or reconfigured'),
  configLoading: t('configuration pas encore lue', 'configuration not read yet'),

  // Test button.
  testNoHost: t('Aucune adresse à tester.', 'No address to test.'),
  testTooSoon: (host) =>
    t(`${host} : testé il y a moins de 5 s`, `${host}: tested less than 5 s ago`),
  testOk: (host, model, mac) =>
    t(`${host} : ${model} (${mac}), connexion réussie`, `${host}: ${model} (${mac}), connected`),

  // Names (language of the names).
  deviceName: { fr: 'Akuvox', en: 'Akuvox' },
  relayState: { fr: (r) => `Relais ${r} (état)`, en: (r) => `Relay ${r} (state)` },
  relayOpen: { fr: (r) => `Ouvrir le relais ${r}`, en: (r) => `Open relay ${r}` },
};

/** "a" -> "A", with the relay's name from the device when it has one: "A (Portail)". */
export const relayLabel = (letter, name) =>
  name ? `${letter.toUpperCase()} (${name})` : letter.toUpperCase();
