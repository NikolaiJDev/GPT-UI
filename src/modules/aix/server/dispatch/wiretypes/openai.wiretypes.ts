import { z } from 'zod';


//
// Implementation notes:
// - 2024-07-09: skipping Functions as they're deprecated
// - 2024-07-09: ignoring logprobs
// - 2024-07-09: ignoring the advanced model configuration
//


export namespace OpenAIWire_ContentParts {

  /// Content parts - Input

  const TextContentPart_schema = z.object({
    type: z.literal('text'),
    text: z.string(),
  });

  const ImageContentPart_schema = z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      // Either a URL of the image or the base64 encoded image data.
      url: z.string(),
      // Control how the model processes the image and generates its textual understanding.
      // https://platform.openai.com/docs/guides/vision/low-or-high-fidelity-image-understanding
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  });

  export const ContentPart_schema = z.discriminatedUnion('type', [
    TextContentPart_schema,
    ImageContentPart_schema,
  ]);

  export function TextContentPart(text: string): z.infer<typeof TextContentPart_schema> {
    return { type: 'text', text };
  }

  export function ImageContentPart(url: string, detail?: 'auto' | 'low' | 'high'): z.infer<typeof ImageContentPart_schema> {
    return { type: 'image_url', image_url: { url, detail } };
  }

  /// Content parts - Output

  const PredictedFunctionCall_schema = z.object({
    /*
     * .optional: for Mistral non-streaming generation - this is fairly weak, and does not let the discriminator work;
     *            please remove this hack asap.
     */
    type: z.literal('function').optional(),
    id: z.string(),
    function: z.object({
      name: z.string(),
      /**
       * Note that the model does not always generate valid JSON, and may hallucinate parameters
       * not defined by your function schema.
       * Validate the arguments in your code before calling your function.
       */
      arguments: z.string(),
    }),
  });

  export function PredictedFunctionCall(toolCallId: string, functionName: string, functionArgs: string): z.infer<typeof PredictedFunctionCall_schema> {
    return { type: 'function', id: toolCallId, function: { name: functionName, arguments: functionArgs } };
  }

  export const ToolCall_schema = z.discriminatedUnion('type', [
    PredictedFunctionCall_schema,
  ]);

}

export namespace OpenAIWire_Messages {

  /// Messages - Input

  // const _optionalParticipantName = z.string().optional();

  const SystemMessage_schema = z.object({
    role: z.literal('system'),
    content: z.string(),
    // name: _optionalParticipantName,
  });

  const UserMessage_schema = z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(OpenAIWire_ContentParts.ContentPart_schema)]),
    // name: _optionalParticipantName,
  });

  export const AssistantMessage_schema = z.object({
    role: z.literal('assistant'),
    /**
     * The contents of the assistant message. Required unless tool_calls or function_call is specified.
     * .optional: when parsing a non-streaming message with just a FC, the content can be missing
     */
    content: z.string().optional().nullable(),
    /**
     * The tool calls generated by the model, such as function calls.
     */
    tool_calls: z.array(OpenAIWire_ContentParts.ToolCall_schema).optional(),
    // name: _optionalParticipantName,
  });

  const ToolMessage_schema = z.object({
    role: z.literal('tool'),
    content: z.string(),
    tool_call_id: z.string(),
  });

  export function ToolMessage(toolCallId: string, content: string): z.infer<typeof ToolMessage_schema> {
    return { role: 'tool', content, tool_call_id: toolCallId };
  }

  export const Message_schema = z.discriminatedUnion('role', [
    SystemMessage_schema,
    UserMessage_schema,
    AssistantMessage_schema,
    ToolMessage_schema,
  ]);

}

export namespace OpenAIWire_Tools {

  /// Tool definitions - Input

  export type FunctionDefinition = z.infer<typeof FunctionDefinition_schema>;
  export const FunctionDefinition_schema = z.object({
    /**
     * The name of the function to be called. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
     */
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, {
      message: 'Tool name must be 1-64 characters long and contain only letters, numbers, underscores, and hyphens',
    }),
    /**
     * A description of what the function does, used by the model to choose when and how to call the function.
     */
    description: z.string().optional(),
    /**
     * The parameters the functions accepts, described as a JSON Schema object.
     * Omitting parameters defines a function with an empty parameter list.
     */
    parameters: z.object({
      type: z.literal('object'),
      /**
       * For stricter validation, use the OpenAPI_Schema.Object_schema
       */
      properties: z.record(z.any()).optional(),
      required: z.array(z.string()).optional(),
    }),
  });

  export const ToolDefinition_schema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('function'),
      function: FunctionDefinition_schema,
    }),
  ]);

  export const ToolChoice_schema = z.union([
    z.literal('none'), // Do not use any tools
    z.literal('auto'), // Let the model decide whether to use tools or generate content
    z.literal('required'), // Must call one or more
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }),
    }),
  ]);

}


//
// Chat > Create chat completion
//
export namespace OpenAIWire_API_Chat_Completions {

  /// Request

  export type Request = z.infer<typeof Request_schema>;
  export const Request_schema = z.object({
    // basic input
    model: z.string(),
    messages: z.array(OpenAIWire_Messages.Message_schema),

    // tool definitions and calling policy
    tools: z.array(OpenAIWire_Tools.ToolDefinition_schema).optional(),
    tool_choice: OpenAIWire_Tools.ToolChoice_schema.optional(),
    parallel_tool_calls: z.boolean().optional(), // defaults to true

    // common model configuration
    max_tokens: z.number().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),

    // API configuration
    n: z.number().int().positive().optional(), // defaulting 'n' to 1, as the derived-ecosystem does not support it
    stream: z.boolean().optional(), // If set, partial message deltas will be sent, with the stream terminated by a `data: [DONE]` message.
    stream_options: z.object({
      include_usage: z.boolean().optional(), // If set, an additional chunk will be streamed with a 'usage' field on the entire request.
    }).optional(),
    response_format: z.object({
      type: z.enum([
        // default
        'text',

        /**
         * When using JSON mode, you must also instruct the model to produce JSON
         * yourself via a system or user message. Without this, the model may generate
         * an unending stream of whitespace until the generation reaches the token limit,
         * resulting in a long-running and seemingly "stuck" request.
         *
         * Also note that the message content may be partially cut off if
         * finish_reason="length", which indicates the generation exceeded max_tokens or
         * the conversation exceeded the max context length.
         */
        'json_object',
      ]),
    }).optional(),
    seed: z.number().int().optional(),
    stop: z.array(z.string()).optional(), // Up to 4 sequences where the API will stop generating further tokens.
    user: z.string().optional(),

    // (disabled) advanced model configuration
    // frequency_penalty: z.number().min(-2).max(2).optional(),
    // presence_penalty: z.number().min(-2).max(2).optional(),
    // logit_bias: z.record(z.number()).optional(),
    // logprobs: z.boolean().optional(),
    // top_logprobs: z.number().int().min(0).max(20).optional(),

    // (disabled) advanced API configuration
    // service_tier: z.unknown().optional(),

  });

  /// Response

  const FinishReason_Enum = z.enum([
    'stop', // natural completion, or stop sequence hit
    'length', // max_tokens exceeded
    'tool_calls', // the model called a tool
    'content_filter', // upstream content filter stopped the generation

    // Extensions //
    '', // [LocalAI] bad response from LocalAI which breaks the parser
    'COMPLETE', // [OpenRouter->Command-R+]
    'STOP', // [OpenRouter->Gemini]
    'end_turn', // [OpenRouter->Anthropic]
    'eos', // [OpenRouter->Phind]
    'error', // [OpenRouter] their network error
    'stop_sequence', // [OpenRouter->Anthropic] added 'stop_sequence' which is the same as 'stop'
  ]);

  const Usage_schema = z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).nullable();

  const Choice_schema = z.object({
    index: z.number(),

    // NOTE: the OpenAI api does not force role: 'assistant', it's only induced
    // We recycle the assistant message response here, with either content or tool_calls
    message: OpenAIWire_Messages.AssistantMessage_schema,

    finish_reason: FinishReason_Enum,
    // logprobs: ... // Log probability information for the choice.
  });

  export type Response = z.infer<typeof Response_schema>;
  export const Response_schema = z.object({
    object: z.literal('chat.completion'),
    id: z.string(), // A unique identifier for the chat completion.

    /**
     * A list of chat completion choices. Can be more than one if n is greater than 1.
     */
    choices: z.array(Choice_schema),

    model: z.string(), // The model used for the chat completion.
    usage: Usage_schema.optional(), // If requested
    created: z.number(), // The Unix timestamp (in seconds) of when the chat completion was created.
    system_fingerprint: z.string().optional() // The backend configuration that the model runs with.
      .nullable(), // [Grow, undocumented OpenAI] fingerprint is null on some OpenAI examples too
    // service_tier: z.unknown().optional(),

    // undocumented messages
    error: z.any().optional(),
    warning: z.unknown().optional(),
  });

  /// Streaming Response

  const _UndocumentedError_schema = z.object({
    // (undocumented) first experienced on 2023-06-19 on streaming APIs
    message: z.string().optional(),
    type: z.string().optional(),
    param: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
  });

  const _UndocumentedWarning_schema = z.string();

  /* Note: this is like the predicted function call, but with fields optional,
     as after the first chunk (which carries type and id), the model will just emit
     some index and function.arguments

     Note2: we found issues with Together, Openrouter, Mistral, and others we don't remember
     This object's status is really a mess for OpenAI and their downstream 'compatibles'.
   */
  const ChunkDeltaToolCalls_schema = z.object({
    index: z.number() // index is not present in non-streaming calls
      .optional(), // [Mistral] not present

    type: z.literal('function').optional(), // currently (2024-07-14) only 'function' is supported

    id: z.string().optional(), // id of the tool call - set likely only in the first chunk

    function: z.object({
      /**
       * Empirical observations:
       * - the name field seems to be set, in full, in the first call
       * - [TogetherAI] added .nullable() - exclusive with 'arguments'
       */
      name: z.string().optional().nullable(),
      /**
       * Note that the model does not always generate valid JSON, and may hallucinate parameters
       * not defined by your function schema.
       * Validate the arguments in your code before calling your function.
       * [TogetherAI] added .nullable() - exclusive with 'name'
       */
      arguments: z.string().optional().nullable(),
    }),
  });

  const ChunkDelta_schema = z.object({
    role: z.literal('assistant').optional()
      .nullable(), // [Deepseek] added .nullable()
    content: z.string().nullable().optional(),
    tool_calls: z.array(ChunkDeltaToolCalls_schema).optional(),
  });

  const ChunkChoice_schema = z.object({
    index: z.number()
      .optional(), // [OpenRouter] added .optional() which implies index=0 I guess

    // A chat completion delta generated by streamed model responses.
    delta: ChunkDelta_schema,

    finish_reason: FinishReason_Enum.nullable()
      .optional(), // [OpenRouter] added .optional() which only has the delta field in the whole chunk choice
    // logprobs: ... // Log probability information for the choice.
  });

  export const ChunkResponse_schema = z.object({
    object: z.enum([
      'chat.completion.chunk',
      'chat.completion', // [Perplexity] sent an email on 2024-07-14 to inform them about the misnomer
      '', // [Azure] bad response: the first packet communicates 'prompt_filter_results'
    ]),
    id: z.string(),

    /**
     * A list of chat completion choices.
     * Can contain more than one elements if n is greater than 1.
     * Can also be empty for the last chunk if you set stream_options: {"include_usage": true}
     */
    choices: z.array(ChunkChoice_schema),

    model: z.string(), // The model used for the chat completion.
    usage: Usage_schema.optional(), // If requested
    created: z.number(), // The Unix timestamp (in seconds) of when the chat completion was created.
    system_fingerprint: z.string().optional() // The backend configuration that the model runs with.
      .nullable(), // [Grow, undocumented OpenAI] fingerprint is null on some OpenAI examples too
    // service_tier: z.unknown().optional(),

    // undocumented streaming messages
    error: _UndocumentedError_schema.optional(),
    warning: _UndocumentedWarning_schema.optional(),
  });

}


//
// Images > Create Image
// https://platform.openai.com/docs/api-reference/images/create
//
export namespace OpenAIWire_API_Images_Generations {

  export type Request = z.infer<typeof Request_schema>;
  const Request_schema = z.object({
    // The maximum length is 1000 characters for dall-e-2 and 4000 characters for dall-e-3
    prompt: z.string().max(4000),

    // The model to use for image generation
    model: z.enum(['dall-e-2', 'dall-e-3']).optional().default('dall-e-2'),

    // The number of images to generate. Must be between 1 and 10. For dall-e-3, only n=1 is supported.
    n: z.number().min(1).max(10).nullable().optional(),

    // 'hd' creates images with finer details and greater consistency across the image. This param is only supported for dall-e-3
    quality: z.enum(['standard', 'hd']).optional(),

    // The format in which the generated images are returned
    response_format: z.enum(['url', 'b64_json']).optional(), //.default('url'),

    // 'dall-e-2': must be one of 256x256, 512x512, or 1024x1024
    // 'dall-e-3': must be one of 1024x1024, 1792x1024, or 1024x1792
    size: z.enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']).optional().default('1024x1024'),

    // only used by 'dall-e-3': 'vivid' (hyper-real and dramatic images) or 'natural'
    style: z.enum(['vivid', 'natural']).optional().default('vivid'),

    // A unique identifier representing your end-user
    user: z.string().optional(),
  });

  export type Response = z.infer<typeof Response_schema>;
  export const Response_schema = z.object({
    created: z.number(),
    data: z.array(z.object({
      url: z.string().url().optional(),
      b64_json: z.string().optional(),
      revised_prompt: z.string().optional(),
    })),
  });

}


//
// Models > List Models
//
export namespace OpenAIWire_API_Models_List {

  export type Model = z.infer<typeof Model_schema>;
  const Model_schema = z.object({
    id: z.string(),
    object: z.literal('model'),
    created: z.number().optional(),
    // [dialect:OpenAI] 'openai' | 'openai-dev' | 'openai-internal' | 'system'
    owned_by: z.string().optional(),

    // **Extensions**
    // [Openrouter] non-standard - commented because dynamically added by the Openrouter vendor code
    // context_length: z.number().optional(),
  });

  export type Response = z.infer<typeof Response_schema>;
  const Response_schema = z.object({
    object: z.literal('list'),
    data: z.array(Model_schema),
  });

}


//
// Moderations > Create Moderation
//
export namespace OpenAIWire_API_Moderations_Create {

  export type Request = z.infer<typeof Request_schema>;
  const Request_schema = z.object({
    // input: z.union([z.string(), z.array(z.string())]),
    input: z.string(),
    model: z.enum(['text-moderation-stable', 'text-moderation-latest']).optional(),
  });

  const Category_schema = z.enum([
    'sexual',
    'hate',
    'harassment',
    'self-harm',
    'sexual/minors',
    'hate/threatening',
    'violence/graphic',
    'self-harm/intent',
    'self-harm/instructions',
    'harassment/threatening',
    'violence',
  ]);

  const Result_schema = z.object({
    flagged: z.boolean(),
    categories: z.record(Category_schema, z.boolean()),
    category_scores: z.record(Category_schema, z.number()),
  });

  export type Response = z.infer<typeof Response_schema>;
  const Response_schema = z.object({
    id: z.string(),
    model: z.string(),
    results: z.array(Result_schema),
  });

}
