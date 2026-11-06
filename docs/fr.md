# Akuvox pour Gladys

Intégration **non officielle, sans lien avec Akuvox**, pour les interphones et contrôles d'accès Akuvox
(séries E, R, X et A : E12, E18, R20, R29, X915, X916, A05…) de votre réseau local, par leur **API HTTP**,
sans le cloud Akuvox. **Jamais testé avec un vrai appareil** : construite d'après la bibliothèque
pylocal-akuvox 1.7.0 et l'intégration Home Assistant « Local Akuvox » 1.0.5. Vos retours sont précieux.

## Ce qu'elle fait

- **État des relais de porte** (relais A à D) : « verrouillé » au repos, « déverrouillé » quand le relais
  est déclenché. En lecture seule.
- **Un bouton « Ouvrir le relais »** par relais, **désactivé par défaut** : il faut cocher « Autoriser
  l'ouverture des portes depuis Gladys ». C'est un bouton poussoir, jamais un interrupteur : un « tout
  éteindre » ou « tout verrouiller » n'ouvre jamais une porte.
- **Déclencheurs de scène** :
  - « Porte Akuvox ouverte » : un accès accordé dans le journal des portes (code, badge, visage,
    application…), avec le relais, le moyen et le nom de l'utilisateur ;
  - « Accès Akuvox refusé » : un accès refusé (mauvais code, badge inconnu…) ;
  - « Appel Akuvox » : un nouvel appel dans le journal des appels (émis, reçu, manqué), avec le nom du
    correspondant. Un visiteur qui sonne fait un appel **émis** sur un interphone de porte.

Le code PIN ou le numéro de badge du journal n'est jamais lu ni publié.

## Préparer l'appareil

Dans la page web de chaque appareil (son adresse IP dans un navigateur) :

1. **Paramètres → API HTTP** (Settings → HTTP API) : activez l'API, choisissez le mode
   d'authentification **Digest** (conseillé) ou Basic, et créez un utilisateur et un mot de passe. Le mode
   « Aucune » ou une liste d'adresses autorisées (allowlist) fonctionne aussi : ajoutez alors l'adresse de
   Gladys à la liste.
2. Donnez à l'appareil une **adresse IP fixe** dans votre box.
3. Les relais doivent être en mode **automatique** (fermeture après un délai), le réglage par défaut. Un
   relais en mode manuel (bistable), ou dont le mode ne peut pas être lu, n'est jamais ouvert par
   l'intégration.

## Configuration

- **Adresses des appareils** : séparées par des virgules, 8 au plus, avec `:port` si la page web n'est pas
  sur le port 80. Le même utilisateur et le même mot de passe servent pour tous.
- **Authentification** : comme sur les appareils. Avec **Digest**, le mot de passe ne circule jamais sur le
  réseau ; avec **Basic**, il circule en clair sur votre réseau local à chaque requête. Si l'appareil
  demande Basic alors que Digest est choisi, rien n'est envoyé et le statut le dit.
- **Intervalle de lecture** : 5 à 300 s (10 s par défaut). Les appareils n'envoient rien d'eux-mêmes : une
  ouverture ou un appel apparaît dans ce délai.
- **Durée d'ouverture** : 1 à 30 s (5 s par défaut). Le relais se referme de lui-même après ce délai,
  quoi qu'il arrive à Gladys : c'est l'appareil qui le referme.

Le bouton **Tester la connexion** lit l'identité de chaque appareil (au plus une fois toutes les 5 s par
appareil).

## Sécurité de l'ouverture

- Désactivée par défaut ; l'option est relue juste avant l'envoi : décochée pendant qu'une ouverture
  attend l'appareil, rien ne part.
- Juste avant chaque ouverture, l'intégration relit l'identité de l'appareil (son adresse MAC) : si un autre
  appareil répond à cette adresse, rien n'est envoyé. Elle relit aussi la configuration du relais : seul un
  relais en mode automatique, de type connu, est ouvert.
- Une ouverture n'est **jamais renvoyée** par l'intégration, ni réessayée, ni rejouée après un redémarrage.
- Une ouverture passe devant les lectures : une lecture lente est abandonnée, jamais attendue.
- Le résultat est dans le statut : « ouvert, confirmé » seulement si le relais, au repos avant, est relu
  déclenché après ; sinon « accepté par l'appareil, pas encore relu », « envoyée, sans réponse (peut-être
  ouvert) », « refusée par l'appareil » ou « rien envoyé » avec la raison.
- Il n'y a pas de commande de fermeture : le relais se referme seul (mode automatique de l'API).

Les refus d'une ouverture avant tout envoi : option décochée, identifiants refusés, appareil inconnu ou
pas encore lu, autre appareil à l'adresse, identité illisible, accès refusé par l'appareil (403), Basic
demandé alors que Digest est choisie, appareil injoignable, configuration des relais illisible ou non
autorisée, mode du relais illisible, relais en mode manuel, relais absent, trop de commandes en attente (4 par appareil),
délai de 3,3 s dépassé avant l'envoi, intégration arrêtée ou reconfigurée.

## Identifiants refusés

Un appareil qui refuse l'utilisateur ou le mot de passe n'est plus sollicité (certains bloquent leur API
après plusieurs échecs) : le statut le dit, et cela tient après un redémarrage. L'intégration réessaie dès
que vous changez les identifiants, enregistrez la configuration ou cliquez sur « Tester la connexion » (un
essai à chaque fois). Un refus d'accès 403 (adresse non autorisée) n'est pas un refus d'identifiants : il
est réessayé après 1 minute, puis 2, 4… jusqu'à une heure. Un 401 ou 403 sur un journal ou sur la
configuration seulement ne compte pas non plus : cette lecture est mise de côté (même espacement), le
statut le dit, et les relais continuent d'être lus.

## Événements : ce qu'il faut savoir

- Une entrée des journaux devient un événement seulement si elle apparaît **entre deux lectures**
  rapprochées : au démarrage, après une coupure de l'appareil plus longue que 2 minutes (ou 3 intervalles),
  ou si le journal a été vidé, les entrées déjà là ne sont pas publiées. L'heure du journal est celle de
  l'appareil, que l'intégration ne peut pas comparer à la sienne : elle ne publie rien de périmé.
- L'entrée qu'une ouverture depuis Gladys laisse dans le journal n'est pas un événement « porte ouverte »
  (une scène qui ouvre la porte sur cet événement tournerait en boucle), quel que soit l'intervalle : la
  marque vit jusqu'à deux lectures du journal après l'ouverture (30 minutes au plus). Une entrée avec un
  code, un badge, un visage… n'est jamais prise pour elle : quelqu'un à la porte est toujours publié.
- Au plus 5 nouvelles entrées par journal et par lecture (les plus récentes), 200 événements par minute.
- Le journal lu est la première page renvoyée par l'appareil : si votre modèle renvoie les plus anciennes
  en premier, dites-le dans le sujet du forum.

## Limites connues

- Un appareil sans API de configuration (`/api/config/get`), ou dont l'utilisateur de l'API ne peut pas la
  lire, n'ouvre jamais : le mode de ses relais ne peut pas être vérifié. Le statut et la réponse de la
  commande le disent. Il en va de même si l'appareil met plus de 1,5 s à la renvoyer.
- Pas encore pris en charge : HTTPS, les moniteurs intérieurs (IT83, ouverture par `/fcgi/do`), les relais
  en mode manuel, les événements poussés par l'appareil (Action URL).
- Données personnelles : le nom de l'utilisateur d'un accès est transmis à vos scènes Gladys, jamais
  ailleurs, jamais dans les journaux de l'intégration.

## Aide

Forum Gladys (sujet de l'intégration) ou issues GitHub du dépôt `LM1LC3N7/gladys-akuvox`.
