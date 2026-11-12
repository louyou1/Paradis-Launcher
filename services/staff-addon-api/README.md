# API des extensions staff Paradis

Ce service distribue des mods réservés au staff, séparément de la distribution publique. Il peut fonctionner sur le même serveur, avec un port différent.

## 1. Installer le service sur le serveur

Le service écoute par défaut sur `127.0.0.1:8091`, donc uniquement en local. Pour le rendre joignable depuis Internet sur le port 8091, il faut l'écouter sur toutes les interfaces et ouvrir le port TCP 8091 dans le pare-feu du serveur (et dans le pare-feu du fournisseur d'hébergement, s'il y en a un).

Copiez `server.js` et `manifest.json` dans un dossier qui n'est pas servi publiquement par votre site, par exemple `/opt/paradis-staff-api/`. Les dossiers `private-data/` et `private-files/` seront créés à cet endroit. Ne placez jamais ce dossier dans la racine publique du site et ne rendez jamais ces fichiers accessibles par le serveur web.

Pour démarrer le service sous Linux pendant un premier essai :

```sh
cd /opt/paradis-staff-api
STAFF_API_HOST=0.0.0.0 STAFF_API_PORT=8091 node server.js
```

Laissez cette session SSH ouverte pendant l'essai. Pour que le service reste actif après la fermeture de SSH et redémarre après un redémarrage du serveur, lancez-le ensuite avec un gestionnaire de services comme `systemd` ou un gestionnaire de processus Node.

Depuis votre ordinateur, vérifiez l'accès en ouvrant cette adresse dans un navigateur :

```text
http://57.131.21.67:8091/health
```

La réponse attendue est `{"status":"ok"}`. Si la page ne répond pas, vérifiez que le service tourne et que le port TCP 8091 est ouvert dans les deux pare-feu concernés.

## 2. Indiquer l'adresse de l'API dans la distribution

Dans le fichier public `distribution.json`, ajoutez la propriété `staffAddon` au niveau principal, sans supprimer les autres propriétés :

```json
"staffAddon": {
  "apiUrl": "http://57.131.21.67:8091/v1"
}
```

L'adresse utilise la même IP que la distribution, avec le port 8091. Le port fait partie de l'adresse : le launcher contacte bien le même serveur.

Cette configuration ne contient aucun secret. Le launcher vérifie que l'hôte de l'API correspond à celui de la distribution.

## 3. Créer un code staff

Dans une autre session SSH, placez-vous dans le dossier du service et créez un code à usage unique pour chaque membre du staff :

```sh
cd /opt/paradis-staff-api
node server.js create-code "Nom du membre"
```

Copiez le code affiché : il ne sera montré qu'une fois. Seul son hash est conservé sur le serveur.

Dans le launcher, ouvrez **Paramètres > Launcher**, saisissez le code dans **Extensions réservées au staff**, puis cliquez sur **Activer**. Le launcher conserve le jeton d'accès dans le stockage sécurisé du système. Le code n'est pas à ressaisir pour chaque lancement.

Pour voir les appareils autorisés ou révoquer un accès :

```sh
node server.js list-tokens
node server.js revoke-token IDENTIFIANT_DU_JETON
```

Le bouton **Retirer l'accès** dans les réglages retire l'accès de cet appareil et révoque son jeton auprès du serveur lorsqu'il est joignable.

## 4. Ajouter ou retirer un mod staff

Le fichier `.jar` doit être présent sur le serveur. L'identifiant du serveur doit correspondre à l'`id` du serveur dans `distribution.json`. Choisissez le type correspondant au modpack : `FabricMod`, `ForgeMod` ou `LiteMod`.

Exemple d'ajout :

```sh
cd /opt/paradis-staff-api
node server.js add-mod paradis-1.21.1 com.paradis:staff-helper:1.0.0 "Staff Helper" FabricMod /chemin/vers/staff-helper-1.0.0.jar
```

Exemple de retrait :

```sh
node server.js remove-mod paradis-1.21.1 com.paradis:staff-helper:1.0.0
```

L'ajout calcule la taille et les empreintes du fichier, puis en copie le JAR dans le stockage privé. Le manifeste est relu à chaque requête : il n'est pas nécessaire de redémarrer le service ni de publier une nouvelle version du launcher quand vous ajoutez ou retirez un mod. Les changements sont récupérés au prochain lancement du jeu.

Les dépendances nécessaires aux mods doivent aussi être ajoutées comme extensions staff, sauf si elles existent déjà dans le modpack public.

## 5. Publier la mise à jour initiale du launcher

Le launcher doit être mis à jour une première fois pour inclure l'écran d'activation et le téléchargement des extensions staff. Publiez cette version une fois sur GitHub Releases. Ensuite, les prochains changements de mods se font sur le serveur et ne demandent pas de nouvelle version du launcher.

## Remarque sur HTTP

Cette configuration transmet les codes, les jetons et les JAR sans chiffrement. Une personne capable d'observer ou de modifier le trafic réseau pourrait les récupérer. Comme le port 8091 est accessible depuis Internet, utilisez un code différent pour chaque membre, révoquez les accès qui ne sont plus nécessaires et gardez des sauvegardes du dossier `private-data/`. HTTPS est préférable si vous pouvez l'activer plus tard.
