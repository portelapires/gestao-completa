import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY")!
const ASAAS_ENV = Deno.env.get("ASAAS_ENV") || "https://api.asaas.com/v3"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const PLAN_CONFIG: Record<number, { value: number; cycle: string; label: string }> = {
  1: { value: 9.90, cycle: "MONTHLY", label: "Gestão Completa — Mensal" },
  12: { value: 69.90, cycle: "YEARLY", label: "Gestão Completa — Anual" },
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    )

    const { data: { user } } = await supabaseClient.auth.getUser()
    if (!user) throw new Error("Usuário não autenticado")

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    const body = await req.json()
    const { action, name, cpfCnpj } = body
    const months = Number(body.planMonths) === 12 ? 12 : 1
    const plan = PLAN_CONFIG[months]

    if (action === "cancel") {
      const { data: sub, error: subError } = await supabaseAdmin
        .from("assinaturas")
        .select("*")
        .eq("user_id", user.id)
        .single()

      if (subError) throw new Error("Não foi possível localizar a assinatura.")

      if (sub?.asaas_subscription_id) {
        const cancelRes = await fetch(
          `${ASAAS_ENV}/subscriptions/${sub.asaas_subscription_id}`,
          {
            method: "DELETE",
            headers: { access_token: ASAAS_API_KEY },
          }
        )

        const cancelData = await cancelRes.json().catch(() => ({}))

        if (!cancelRes.ok) {
          throw new Error(
            cancelData?.errors?.[0]?.description ||
              "O Asaas não confirmou o cancelamento. Tente novamente."
          )
        }
      }

      const now = new Date().toISOString()
      const { error: updateError } = await supabaseAdmin
        .from("assinaturas")
        .update({
          status: "canceled",
          canceled_at: now,
          updated_at: now,
        })
        .eq("user_id", user.id)

      if (updateError) throw new Error("Não foi possível atualizar a assinatura após o cancelamento.")

      return new Response(
        JSON.stringify({ success: true, accessUntil: sub?.current_period_end }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const customerRes = await fetch(`${ASAAS_ENV}/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
      body: JSON.stringify({ name, email: user.email, cpfCnpj }),
    })
    const customer = await customerRes.json()
    if (!customer.id) throw new Error(customer.errors?.[0]?.description || "Erro ao criar cliente no Asaas")

    const today = new Date().toISOString().split("T")[0]
    const subRes = await fetch(`${ASAAS_ENV}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
      body: JSON.stringify({
        customer: customer.id,
        billingType: "UNDEFINED",
        value: plan.value,
        nextDueDate: today,
        cycle: plan.cycle,
        description: `${plan.label} - Gestão Completa`,
      }),
    })
    const subscription = await subRes.json()
    if (!subscription.id) throw new Error(subscription.errors?.[0]?.description || "Erro ao gerar assinatura")

    const paymentsRes = await fetch(`${ASAAS_ENV}/subscriptions/${subscription.id}/payments`, {
      headers: { access_token: ASAAS_API_KEY },
    })
    const paymentsData = await paymentsRes.json()
    const invoiceUrl = paymentsData.data?.[0]?.invoiceUrl

    await supabaseAdmin
      .from("assinaturas")
      .upsert({
        user_id: user.id,
        email: user.email!.toLowerCase(),
        asaas_customer_id: customer.id,
        asaas_subscription_id: subscription.id,
        plan_months: months,
        updated_at: new Date().toISOString(),
      }, { onConflict: "email" })

    return new Response(JSON.stringify({ invoiceUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})