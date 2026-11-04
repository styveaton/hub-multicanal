# Mettre OmniList en ligne sur le VPS (pas à pas)

Résultat : **https://omnilist.1handbiz.com** sert le site. Le site relaie `/api` vers l'API, comme en local.
Tout tourne dans Docker sur le VPS : site, API, worker, Postgres, Redis et stockage des photos.
Seul le site est ouvert, sur `127.0.0.1:3100`. Le proxy HTTPS déjà présent sur le serveur (openresty / nginx) le publie.

Durée : environ 1 h la première fois. Les commandes `$` sont à taper sur le VPS, sauf mention « sur ton PC ».

---

## Étape 1. Créer le sous-domaine (DNS)

Les DNS de 1handbiz.com sont gérés par le Mail-in-a-Box **box.gessiia.com**.

1. Ouvre https://box.gessiia.com/admin et connecte-toi.
2. Menu **System › Custom DNS**.
3. Ajoute un enregistrement :
   - Name : `omnilist.1handbiz.com`
   - Type : `A (IPv4 address)`
   - Value : l'adresse IP de ton VPS (1handbiz.com pointe aujourd'hui vers `62.171.143.117` ; si c'est ce VPS, mets cette IP)
4. Vérifie quelques minutes plus tard, sur ton PC : `nslookup omnilist.1handbiz.com` doit répondre l'IP du VPS.

## Étape 2. Vérifier le VPS

Connecte-toi : `ssh <utilisateur>@<IP du VPS>`, puis :

```bash
$ cat /etc/os-release | head -2          # système (Ubuntu / Debian conseillés)
$ free -h                               # mémoire : 2 Go minimum, 4 Go conseillés
$ df -h /                               # disque : 10 Go libres minimum
$ docker compose version                # Docker déjà installé ?
$ sudo ss -ltnp | grep -E ':(80|443|3100) '   # qui écoute sur 80/443 ? 3100 doit être libre
```

- **Docker absent** : `curl -fsSL https://get.docker.com | sudo sh`, puis `sudo usermod -aG docker $USER`. Déconnecte-toi et reconnecte-toi.
- **Moins de 4 Go de mémoire** : la construction du site (Next.js) peut manquer de mémoire. Ajoute 2 Go de swap :
  ```bash
  $ sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  $ echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
- **Port 3100 déjà pris** : choisis un autre port. Crée `deploy/.env` avec `OMNILIST_PORT=3200`.

## Étape 3. Récupérer le code

Le dépôt GitHub est public : un simple clonage suffit (aucun secret n'y est, ils restent dans `env/production.env`).

```bash
$ sudo mkdir -p /opt/omnilist && sudo chown $USER /opt/omnilist
$ git clone https://github.com/styveaton/hub-multicanal.git /opt/omnilist
$ cd /opt/omnilist
```

## Étape 4. Préparer les variables d'environnement

1. **Sur ton PC**, envoie le fichier qui contient déjà les clés eBay et Etsy de production :
   ```bash
   scp C:\Users\o\Documents\hub-multicanal\env\production.env <utilisateur>@<IP du VPS>:/opt/omnilist/env/production.env
   ```
2. **Sur le VPS**, complète automatiquement l'adresse du site, la base, Redis, les photos et les clés secrètes. Le script ne remplace aucune valeur déjà remplie.
   ```bash
   $ bash deploy/setup-env.sh omnilist.1handbiz.com
   ```
3. **Emails** (invitations des membres) : utilise ton Mail-in-a-Box.
   - Dans https://box.gessiia.com/admin, menu **Mail › Users**, crée `no-reply@1handbiz.com` avec un mot de passe.
   - Puis ouvre le fichier avec `nano env/production.env` et complète :
     ```
     SMTP_HOST=box.gessiia.com
     SMTP_PORT=587
     SMTP_USER=no-reply@1handbiz.com
     SMTP_PASS=<mot de passe de la boîte>
     MAIL_FROM=OmniList <no-reply@1handbiz.com>
     ```
4. **Etsy, tant que l'application n'est pas approuvée** : mets un `#` devant `ETSY_KEYSTRING=`. Sinon le bouton « Connecter Etsy » apparaît mais la connexion échoue. Retire le `#` après l'approbation, puis relance (étape 8).
5. **eBay** reste masqué tant que `EBAY_RUNAME` est vide. C'est normal (voir l'étape 9).

## Étape 5. Lancer OmniList

```bash
$ docker compose -f deploy/docker-compose.yml up -d --build
```

La première construction prend 5 à 15 minutes. Ensuite :

```bash
$ docker compose -f deploy/docker-compose.yml ps        # api, worker, web, postgres, redis, s3 : « running » ; migrate : « exited (0) »
$ docker compose -f deploy/docker-compose.yml logs -f api worker   # Ctrl+C pour quitter
$ curl -I http://127.0.0.1:3100/login                   # doit répondre « HTTP/1.1 200 OK »
```

## Étape 6. Publier en HTTPS (proxy déjà présent sur le VPS)

Un serveur **openresty** (famille nginx) écoute déjà sur les ports 80 et 443. Il faut y ajouter un site pour `omnilist.1handbiz.com`. Ce site relaie vers `http://127.0.0.1:3100` avec un certificat Let's Encrypt.

**Avec un panneau** (1Panel, aaPanel, Nginx Proxy Manager…) : crée un site de type « reverse proxy » :
- Domaine : `omnilist.1handbiz.com`
- Destination : `http://127.0.0.1:3100`
- SSL : Let's Encrypt, avec « forcer HTTPS » activé
- Taille maximale d'envoi : 15 Mo (photos jusqu'à 10 Mo)

**Avec Nginx Proxy Manager installé dans Docker** : `127.0.0.1` désigne alors le conteneur lui-même.
1. Crée `deploy/.env` avec `OMNILIST_BIND=172.17.0.1`.
2. Relance l'étape 5.
3. Mets `http://172.17.0.1:3100` comme destination.

**Avec Nginx Proxy Manager sur un autre serveur du réseau local** (cas actuel : NPM reçoit 69.251.219.67, OmniList tourne sur proserver `10.0.0.23`) :
1. Crée `deploy/.env` avec `OMNILIST_BIND=10.0.0.23`. OmniList n'écoute alors que sur le réseau local, pas sur internet.
2. Relance l'étape 5.
3. Dans NPM, crée un Proxy Host qui redirige vers `http://10.0.0.23:3100`.
4. Ne redirige pas le port 3100 sur la box ou le routeur.

**Avec nginx configuré à la main**, utilise ce bloc (le certificat se crée avec `certbot --nginx -d omnilist.1handbiz.com`) :

```nginx
server {
    server_name omnilist.1handbiz.com;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
    listen 80;
}
```

Vérifie ensuite depuis ton PC : https://omnilist.1handbiz.com doit afficher la page de connexion, avec le cadenas.

## Étape 7. Essai complet

1. Crée ton compte sur https://omnilist.1handbiz.com/signup.
2. Crée un produit et ajoute une photo : elle doit s'afficher.
3. Invite un membre (Équipe) : l'email doit arriver.
4. Canaux : seuls les canaux qui ont leurs clés apparaissent comme disponibles.

## Étape 8. Mises à jour, sauvegardes, dépannage

- **Mettre à jour** après un push sur GitHub : `bash deploy/update.sh`. Il récupère le code, reconstruit, applique les migrations et relance.
- **Sauvegarde de la base chaque nuit** : lance `crontab -e` et ajoute la ligne
  `17 3 * * * /bin/bash /opt/omnilist/deploy/backup.sh >> /opt/omnilist/deploy/backups/cron.log 2>&1`.
  Les copies vont dans `deploy/backups` (les 14 dernières sont gardées). Pense à les copier ailleurs de temps en temps.
- **Après une modification de `env/production.env`** : `docker compose -f deploy/docker-compose.yml up -d`.
- **Voir les erreurs** : `docker compose -f deploy/docker-compose.yml logs --tail 100 api worker web`.

## Étape 9. Une fois en ligne : déclarer les adresses chez eBay et Etsy

- **eBay** (voir [DEMARCHES-EXTERNES.md](DEMARCHES-EXTERNES.md), section 1) :
  - Avis de suppression de compte : `https://omnilist.1handbiz.com/api/webhooks/ebay/account-deletion`, avec le jeton `EBAY_VERIFICATION_TOKEN` de `env/production.env`. Une fois validé, eBay active les clés Production.
  - RuName : accepted URL `https://omnilist.1handbiz.com/api/channels/ebay/callback`, declined URL `https://omnilist.1handbiz.com/api/channels/ebay/callback?error=access_denied`. Reporte le nom généré dans `EBAY_RUNAME`, puis relance.
- **Etsy**, après l'approbation : adresse de retour `https://omnilist.1handbiz.com/api/channels/etsy/callback`, et Website URL `https://omnilist.1handbiz.com`.
