# Winku

A desktop assistant that lives as a pair of eyes at the edge of the screen. These are the words its docs and code use for things specific to it.

## Conversation

**Thread**:
The one running conversation with the assistant, kept until the user clears it.
_Avoid_: Chat, session (pi's word for the file a thread is stored in)

**Steer**:
A message sent while a reply is running, which the model takes in at its next step instead of after the reply ends.
_Avoid_: Interrupt, queue, follow-up

## Scheduled tasks

**Task**:
A wakeup the assistant scheduled because the user asked it to: a timer, a loop or a watch.
_Avoid_: Job (in user-facing text), cron, reminder (a reminder is one kind of timer)

**Timer**:
A task that runs its prompt once, at a time or after a delay.
_Avoid_: Alarm, one-shot

**Loop**:
A task that runs its prompt again and again, every interval or at delays the model picks (self-paced).
_Avoid_: Recurring job, poll

**Watch**:
A task that runs a command in the background and wakes Winku with each line the command prints.
_Avoid_: Monitor, listener, poll

**Run**:
One scheduled turn: a task's prompt sent to the model, marked `[scheduled: <name>]`.
_Avoid_: Fire, execution, trigger

**Notice**:
A one-line row the scheduler adds to the thread, such as a missed wakeup or a stopped task, which the model also sees.
_Avoid_: Alert, toast (a toast is the bar's temporary message)
