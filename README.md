# Controle de Facção — Dashboard

Dashboard web para visualização dos dados da planilha "Controle de Facção".

## 🚀 Deploy no Railway

### Passo 1 — Coloque os arquivos no GitHub
1. Crie um repositório em https://github.com
2. Faça upload de todos os arquivos desta pasta
3. Commit e push

### Passo 2 — Deploy no Railway
1. Acesse https://railway.com
2. Clique em **"New Project"**
3. Selecione **"Deploy from GitHub repo"**
4. Autorize o GitHub e selecione seu repositório
5. Aguarde o build (1–2 minutos)
6. Vá em **Settings → Networking → Generate Domain**
7. ✅ Pronto! Sua URL pública estará disponível

## ⚙️ Rodando localmente

```bash
npm install
npm start
```
Acesse: http://localhost:3000

## 📋 Requisitos
- Node.js 18+
- A planilha Google Sheets deve estar pública (qualquer pessoa com o link pode ver)

## 🗂️ Estrutura
```
controle-faccao/
├── server.js         # Backend Express
├── public/
│   └── index.html    # Dashboard frontend
├── package.json
├── Procfile
└── README.md
```
