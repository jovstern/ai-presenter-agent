'use server'

import { z } from 'zod'

// Reference pattern for every mutation (Next.js Learn, chapters 11-13): a Server Action that
// validates FormData with Zod safeParse and returns field errors for useActionState. A real
// action then writes to the database inside try/catch, calls revalidatePath(), and calls
// redirect() after the try/catch.

const GreetingSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name'),
})

export type GreetingState = {
  errors?: { name?: string[] }
  message?: string | null
}

export async function greet(_prevState: GreetingState, formData: FormData): Promise<GreetingState> {
  const validatedFields = GreetingSchema.safeParse({ name: formData.get('name') })

  if (!validatedFields.success) {
    return {
      errors: z.flattenError(validatedFields.error).fieldErrors,
      message: null,
    }
  }

  return { message: `Hello, ${validatedFields.data.name}!` }
}
