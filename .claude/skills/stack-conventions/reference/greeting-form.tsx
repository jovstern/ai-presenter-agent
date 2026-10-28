'use client'

import { useActionState } from 'react'
import { greet, type GreetingState } from '@/app/lib/actions'

// Reference pattern for every form (Next.js Learn, chapter 13): useActionState + a Server
// Action, label tied to the input, errors in an aria-live region linked by aria-describedby.
export default function GreetingForm() {
  const initialState: GreetingState = { message: null, errors: {} }
  const [state, formAction, isPending] = useActionState(greet, initialState)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="name" className="text-sm font-medium">
          Your name
        </label>
        <input
          id="name"
          name="name"
          className="rounded border px-3 py-2"
          aria-describedby="name-error"
        />
        <div id="name-error" aria-live="polite" aria-atomic="true">
          {state.errors?.name?.map((error) => (
            <p key={error} className="text-sm text-red-700">
              {error}
            </p>
          ))}
        </div>
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        Say hello
      </button>
      {state.message ? <p>{state.message}</p> : null}
    </form>
  )
}
