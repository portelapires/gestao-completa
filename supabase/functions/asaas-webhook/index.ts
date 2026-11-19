import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const WEBHOOK_TOKEN = Deno.env.get("ASAAS_WEBHOOK_TOKEN")

serve(async (req) => {
  try {
    if (!WEBHOOK_TOKEN) {
      return new Response(JSON.stringify({ error: "Webhook não configurado." }), { status: 500 })
    }

    if (req.headers.get("asaas-access-token") !== WEBHOOK_TOKEN) {
      return new Response(JSON.stringify({ error: "Token do webhook inválido." }), { status: 401 })
    }

    const body = await req.json()
    const event = body.event
    const payment = body.payment

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    const customerId = payment?.customer || body.subscription?.customer
    if (!customerId) return new Response("ok", { status: 200 })

    if ((event === "PAYMENT_CONFIRMED" || event === "PAYMENT_RECEIVED") && payment?.id) {
      const { data: existingPayment } = await supabaseAdmin
        .from("pagamentos_mensais")
        .select("id")
        .eq("asaas_payment_id", payment.id)
        .maybeSingle()

      if (existingPayment) {
        return new Response(JSON.stringify({ received: true, duplicated: true }), { status: 200 })
      }

      const { data: sub } = await supabaseAdmin
        .from("assinaturas")
        .select("*")
        .eq("asaas_customer_id", customerId)
        .maybeSingle()

      const monthsToAdd = sub?.plan_months || 1
      const baseDate = payment?.dueDate ? new Date(payment.dueDate + "T12:00:00Z") : new Date()
      baseDate.setMonth(baseDate.getMonth() + monthsToAdd)
      const nextPeriodEnd = baseDate.toISOString().split("T")[0]

      await supabaseAdmin
        .from("assinaturas")
        .update({
          status: "active",
          current_period_end: nextPeriodEnd,
          canceled_at: null,
          suspended_at: null,
          purge_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("asaas_customer_id", customerId)
        .neq("status", "courtesy")

      await supabaseAdmin
        .from("pagamentos_mensais")
        .insert({
          user_id: sub?.user_id,
          asaas_payment_id: payment.id,
          valor: payment.value,
          data_pagamento: payment.paymentDate || payment.confirmedDate || new Date().toISOString(),
        })
    }

    if (event === "SUBSCRIPTION_DELETED") {
      const { data: sub } = await supabaseAdmin
        .from("assinaturas")
        .select("*")
        .eq("asaas_customer_id", customerId)
        .maybeSingle()

      if (sub && sub.status !== "courtesy") {
        const now = new Date()
        const limit = sub.current_period_end ? new Date(sub.current_period_end + "T23:59:59Z") : now
        limit.setDate(limit.getDate() + 3)

        if (now > limit) {
          const purgeDate = new Date()
          purgeDate.setDate(purgeDate.getDate() + 90)
          await supabaseAdmin
            .from("assinaturas")
            .update({
              status: "suspended",
              suspended_at: now.toISOString(),
              purge_at: purgeDate.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq("asaas_customer_id", customerId)
        } else {
          await supabaseAdmin
            .from("assinaturas")
            .update({ status: "canceled", canceled_at: now.toISOString() })
            .eq("asaas_customer_id", customerId)
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 })
  }
})