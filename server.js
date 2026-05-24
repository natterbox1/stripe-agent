/**
 * ============================================================
 *  STRIPE CALL AGENT — Serveur de paiement mensuel 1000$/mois
 * ============================================================
 *
 * SETUP (une seule fois) :
 *   1. npm install express stripe dotenv nodemailer
 *   2. Copier .env.example → .env et remplir les valeurs
 *   3. node server.js
 *
 * STRIPE DASHBOARD (à faire une seule fois) :
 *   - Créer un Produit "Call Agent Service" à 1000$/mois
 *   - Copier le Price ID (price_xxxx) dans .env → STRIPE_PRICE_ID
 *   - Webhooks → ajouter endpoint: https://ton-domaine.com/webhook
 *     Écouter ces événements :
 *       • customer.subscription.deleted
 *       • customer.subscription.updated
 *       • invoice.payment_succeeded
 *       • invoice.payment_failed
 */

require("dotenv").config();
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();

// ─── Fichiers statiques (index.html, success.html) ───────────────────────────
app.use(express.static(__dirname));

// ─── Webhook Stripe : doit être AVANT express.json() ─────────────────────────
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature invalide:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const data = event.data.object;

    switch (event.type) {

      // ── Client annule son abonnement ────────────────────────────────────────
      case "customer.subscription.deleted": {
        const customer = await stripe.customers.retrieve(data.customer);
        const endDate = new Date(data.current_period_end * 1000).toLocaleDateString("fr-CA");
        
        await sendEmail({
          subject: "🔴 ANNULATION — Client a annulé son abonnement",
          html: `
            <h2 style="color:#dc2626">Annulation d'abonnement</h2>
            <p><strong>Client :</strong> ${customer.name || "Inconnu"}</p>
            <p><strong>Email :</strong> ${customer.email}</p>
            <p><strong>Accès jusqu'au :</strong> ${endDate}</p>
            <p><strong>ID abonnement :</strong> ${data.id}</p>
            <hr/>
            <p style="color:#6b7280">Dernier paiement reçu inclus dans la période courante.</p>
          `,
        });
        console.log(`❌ Annulation: ${customer.email} — fin le ${endDate}`);
        break;
      }

      // ── Client planifie une annulation (cancel_at_period_end = true) ────────
      case "customer.subscription.updated": {
        if (data.cancel_at_period_end === true) {
          const customer = await stripe.customers.retrieve(data.customer);
          const cancelDate = new Date(data.cancel_at * 1000);
          const today = new Date();
          const daysLeft = Math.ceil((cancelDate - today) / (1000 * 60 * 60 * 24));
          const cancelDateStr = cancelDate.toLocaleDateString("fr-CA");

          await sendEmail({
            subject: `⚠️ ALERTE — Client va annuler dans ${daysLeft} jours`,
            html: `
              <h2 style="color:#f59e0b">Annulation planifiée</h2>
              <p><strong>Client :</strong> ${customer.name || "Inconnu"}</p>
              <p><strong>Email :</strong> ${customer.email}</p>
              <p><strong>Date d'annulation :</strong> ${cancelDateStr}</p>
              <p><strong>Jours restants :</strong> <span style="color:#dc2626;font-size:1.4em;font-weight:bold">${daysLeft} jours</span></p>
              <p><strong>ID abonnement :</strong> ${data.id}</p>
              <hr/>
              <p style="color:#059669"><strong>💡 Action recommandée :</strong> Contacte ce client maintenant pour retenir l'abonnement !</p>
            `,
          });

          // ── Programmer un rappel si annulation dans plus de 14 jours ────────
          if (daysLeft > 14) {
            const reminderDelay = (daysLeft - 14) * 24 * 60 * 60 * 1000;
            setTimeout(async () => {
              await sendEmail({
                subject: `🔔 RAPPEL — ${customer.email} annule dans 14 jours`,
                html: `
                  <h2 style="color:#dc2626">Rappel : annulation dans 14 jours</h2>
                  <p><strong>Client :</strong> ${customer.name || "Inconnu"}</p>
                  <p><strong>Email :</strong> ${customer.email}</p>
                  <p><strong>Date d'annulation :</strong> ${cancelDateStr}</p>
                  <hr/>
                  <p style="color:#059669">⏰ Il te reste exactement 14 jours pour agir !</p>
                `,
              });
            }, reminderDelay);
          }

          console.log(`⚠️ Annulation planifiée: ${customer.email} — dans ${daysLeft} jours`);
        }
        break;
      }

      // ── Paiement mensuel réussi ──────────────────────────────────────────────
      case "invoice.payment_succeeded": {
        if (data.billing_reason === "subscription_cycle") {
          const customer = await stripe.customers.retrieve(data.customer);
          const amount = (data.amount_paid / 100).toFixed(2);

          await sendEmail({
            subject: `✅ Paiement reçu — ${customer.email} — $${amount}`,
            html: `
              <h2 style="color:#059669">Paiement mensuel reçu !</h2>
              <p><strong>Client :</strong> ${customer.name || "Inconnu"}</p>
              <p><strong>Email :</strong> ${customer.email}</p>
              <p><strong>Montant :</strong> $${amount} USD</p>
              <p><strong>Invoice :</strong> <a href="${data.hosted_invoice_url}">Voir la facture</a></p>
            `,
          });
          console.log(`✅ Paiement reçu: $${amount} de ${customer.email}`);
        }
        break;
      }

      // ── Paiement échoué ──────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const customer = await stripe.customers.retrieve(data.customer);

        await sendEmail({
          subject: `🚨 PAIEMENT ÉCHOUÉ — ${customer.email}`,
          html: `
            <h2 style="color:#dc2626">Paiement mensuel échoué</h2>
            <p><strong>Client :</strong> ${customer.name || "Inconnu"}</p>
            <p><strong>Email :</strong> ${customer.email}</p>
            <p><strong>Stripe va réessayer automatiquement.</strong></p>
            <p>Si ça persiste, contacte le client pour mettre à jour sa carte.</p>
          `,
        });
        console.log(`🚨 Paiement échoué: ${customer.email}`);
        break;
      }
    }

    res.json({ received: true });
  }
);

// ─── JSON parser pour les autres routes ──────────────────────────────────────
app.use(express.json());

// ─── Créer une session Stripe Checkout (abonnement mensuel) ──────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { customerName, customerEmail } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      customer_email: customerEmail,
      subscription_data: {
        metadata: { customerName },
        // Permet au client d'annuler lui-même → déclenche le webhook
        cancel_at_period_end: false,
      },
      success_url: `${process.env.YOUR_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.YOUR_DOMAIN}/index.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur checkout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Portail client (gérer abonnement / annuler) ─────────────────────────────
app.post("/create-portal-session", async (req, res) => {
  const { sessionId } = req.body;

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: checkoutSession.customer,
      return_url: `${process.env.YOUR_DOMAIN}/success.html`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fonction d'envoi d'email (toi → notifié) ────────────────────────────────
async function sendEmail({ subject, html }) {
  const transporter = nodemailer.createTransport({
    service: "gmail", // ou "outlook", ou SMTP custom
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASSWORD, // App Password Gmail recommandé
    },
  });

  await transporter.sendMail({
    from: `"Call Agent Bot" <${process.env.EMAIL_FROM}>`,
    to: process.env.EMAIL_TO, // ton email personnel
    subject,
    html,
  });
}

// ─── Démarrage du serveur ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`📋 Checklist :`);
  console.log(`   ✅ Stripe Secret Key: ${process.env.STRIPE_SECRET_KEY ? "OK" : "❌ MANQUANT"}`);
  console.log(`   ✅ Stripe Price ID:   ${process.env.STRIPE_PRICE_ID ? "OK" : "❌ MANQUANT"}`);
  console.log(`   ✅ Webhook Secret:    ${process.env.STRIPE_WEBHOOK_SECRET ? "OK" : "❌ MANQUANT"}`);
  console.log(`   ✅ Email configuré:   ${process.env.EMAIL_FROM ? "OK" : "❌ MANQUANT"}\n`);
});
