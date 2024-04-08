import { extendDeep } from '../utilities/ObjectUtilities.js'

import { logToStderr } from '../utilities/Utilities.js'
import { AudioSourceParam, RawAudio, downmixToMonoAndNormalize, ensureRawAudio, getRawAudioDuration, normalizeAudioLevel, trimAudioEnd } from '../audio/AudioUtilities.js'
import { Logger } from '../utilities/Logger.js'
import { resampleAudioSpeex } from '../dsp/SpeexResampler.js'

import * as API from './API.js'
import { Timeline, addTimeOffsetToTimeline, addWordTextOffsetsToTimeline, wordTimelineToSegmentSentenceTimeline } from '../utilities/Timeline.js'
import { formatLanguageCodeWithName, getDefaultDialectForLanguageCodeIfPossible, getShortLanguageCode, normalizeLanguageCode } from '../utilities/Locale.js'
import { WhisperOptions } from '../recognition/WhisperSTT.js'
import chalk from 'chalk'
import { DtwGranularity } from '../alignment/SpeechAlignment.js'
import { SubtitlesConfig, defaultSubtitlesBaseConfig } from '../subtitles/Subtitles.js'
import { synthesize } from './API.js'
import { EspeakOptions, defaultEspeakOptions } from '../synthesis/EspeakTTS.js'

const log = logToStderr

export async function align(input: AudioSourceParam, transcript: string, options: AlignmentOptions): Promise<AlignmentResult> {
	const logger = new Logger()

	const startTimestamp = logger.getTimestamp()

	options = extendDeep(defaultAlignmentOptions, options)

	const inputRawAudio = await ensureRawAudio(input)

	let sourceRawAudio: RawAudio
	let isolatedRawAudio: RawAudio | undefined
	let backgroundRawAudio: RawAudio | undefined

	if (options.isolate) {
		logger.log(``)
		logger.end();

		({ isolatedRawAudio, backgroundRawAudio } = await API.isolate(inputRawAudio, options.separation!))

		logger.end()
		logger.log(``)

		sourceRawAudio = await ensureRawAudio(isolatedRawAudio, 16000, 1)
	} else {
		sourceRawAudio = await ensureRawAudio(inputRawAudio, 16000, 1)
	}

	let sourceUncropTimeline: Timeline | undefined

	if (options.crop) {
		logger.start('Crop using voice activity detection');
		({ timeline: sourceUncropTimeline, croppedRawAudio: sourceRawAudio } = await API.detectVoiceActivity(sourceRawAudio, options.vad!))

		logger.end()
	}

	logger.start('Prepare for alignment')

	sourceRawAudio = normalizeAudioLevel(sourceRawAudio)
	sourceRawAudio.audioChannels[0] = trimAudioEnd(sourceRawAudio.audioChannels[0])

	if (options.dtw!.windowDuration == null) {
		const sourceAudioDuration = getRawAudioDuration(sourceRawAudio)

		if (sourceAudioDuration < 5 * 60) { // If up to 5 minutes, set window to one minute
			options.dtw!.windowDuration = 60
		} else if (sourceAudioDuration < 60 * 60) { // If up to 1 hour, set window to 20% of total duration
			options.dtw!.windowDuration = Math.ceil(sourceAudioDuration * 0.2)
		} else { // If 1 hour or more, set window to 12 minutes
			options.dtw!.windowDuration = 12 * 60
		}
	}

	let language: string

	if (options.language) {
		language = normalizeLanguageCode(options.language!)
	} else {
		logger.start('No language specified. Detecting language')
		const { detectedLanguage } = await API.detectTextLanguage(transcript, options.languageDetection || {})
		language = detectedLanguage

		logger.end()
		logger.logTitledMessage('Language detected', formatLanguageCodeWithName(detectedLanguage))
	}

	language = getDefaultDialectForLanguageCodeIfPossible(language)

	logger.start('Load alignment module')

	const { alignUsingDtwWithRecognition, alignUsingDtw } = await import('../alignment/SpeechAlignment.js')

	async function getAlignmentReference() {
		logger.start('Create alignment reference with eSpeak')

		const synthesisOptions: API.SynthesisOptions = {
			engine: 'espeak',
			language,
			plainText: options.plainText,
			customLexiconPaths: options.customLexiconPaths,

			espeak: {
				useKlatt: false
			}
		}

		let { audio: referenceRawAudio, timeline: segmentTimeline, voice: espeakVoice } = await synthesize(transcript, synthesisOptions)

		const sentenceTimeline = segmentTimeline.flatMap(entry => entry.timeline!)
		const wordTimeline = sentenceTimeline.flatMap(entry => entry.timeline!)

		referenceRawAudio = await resampleAudioSpeex(referenceRawAudio as RawAudio, 16000)
		referenceRawAudio = downmixToMonoAndNormalize(referenceRawAudio)

		return { referenceRawAudio, referenceTimeline: wordTimeline, espeakVoice }
	}

	function getDtwWindowDurationsAndGranularities() {
		let granularities: DtwGranularity[]
		let windowDurations: number[]

		if (typeof options.dtw!.granularity == 'string') {
			granularities = [options.dtw!.granularity]
		} else if (Array.isArray(options.dtw!.granularity)) {
			granularities = options.dtw!.granularity
		} else {
			granularities = ['auto']
		}

		if (typeof options.dtw!.windowDuration == 'number') {
			if (granularities.length == 1) {
				windowDurations = [options.dtw!.windowDuration]
			} else if (granularities.length == 2) {
				windowDurations = [options.dtw!.windowDuration, 15]
			} else {
				throw new Error(`More than two passes requested, this requires window durations to be explicitly specified for each pass. For example 'dtw.windowDuration=[600,60,10]'.`)
			}
		} else if (Array.isArray(options.dtw!.windowDuration)) {
			windowDurations = options.dtw!.windowDuration
		} else {
			throw new Error('No window duration given')
		}

		if (granularities.length != windowDurations.length) {
			throw new Error(`Unequal element counts in options. 'dtw.granularity' has ${granularities.length} items, but 'dtw.windowDuration' has ${windowDurations.length} items. Can't infer what number of DTW passes were intended.`)
		}

		return { windowDurations, granularities }
	}

	let mappedTimeline: Timeline

	switch (options.engine) {
		case 'dtw': {
			const { referenceRawAudio, referenceTimeline } = await getAlignmentReference()
			logger.end()

			const { windowDurations, granularities } = getDtwWindowDurationsAndGranularities()

			mappedTimeline = await alignUsingDtw(sourceRawAudio, referenceRawAudio, referenceTimeline, granularities, windowDurations)

			break
		}

		case 'dtw-ra': {
			const recognitionOptionsDefaults: API.RecognitionOptions = {
				engine: 'whisper',
				language,
			}

			const recognitionOptions: API.RecognitionOptions =
				extendDeep({ ...recognitionOptionsDefaults, crop: options.crop }, options.recognition || {})

			logger.end()

			const { wordTimeline: recognitionTimeline } = await API.recognize(sourceRawAudio, recognitionOptions)

			const { referenceRawAudio, referenceTimeline, espeakVoice } = await getAlignmentReference()

			logger.end()

			const { windowDurations, granularities } = getDtwWindowDurationsAndGranularities()

			const espeakOptions: EspeakOptions = { ...defaultEspeakOptions, voice: espeakVoice, useKlatt: false }

			const phoneAlignmentMethod = options.dtw!.phoneAlignmentMethod!

			mappedTimeline = await alignUsingDtwWithRecognition(sourceRawAudio, referenceRawAudio, referenceTimeline, recognitionTimeline, granularities, windowDurations, espeakOptions, phoneAlignmentMethod)

			break
		}

		case 'whisper': {
			const WhisperSTT = await import('../recognition/WhisperSTT.js')

			const whisperOptions = options.whisper!

			const shortLanguageCode = getShortLanguageCode(language)

			const { modelName, modelDir } = await WhisperSTT.loadPackagesAndGetPaths(whisperOptions.model, language)

			if (getRawAudioDuration(sourceRawAudio) > 30) {
				throw new Error('Whisper based alignment currently only supports audio inputs that are 30s or less')
			}

			logger.end()

			mappedTimeline = await WhisperSTT.align(sourceRawAudio, transcript, modelName, modelDir, shortLanguageCode)

			break
		}

		default: {
			throw new Error(`Engine '${options.engine}' is not supported`)
		}
	}

	// If the audio was cropped before recognition, map the timestamps back to the original audio
	if (sourceUncropTimeline && sourceUncropTimeline.length > 0) {
		API.convertCroppedToUncroppedTimeline(mappedTimeline, sourceUncropTimeline)
	}

	// Add text offsets
	addWordTextOffsetsToTimeline(mappedTimeline, transcript)

	// Make segment timeline
	const { segmentTimeline } = await wordTimelineToSegmentSentenceTimeline(mappedTimeline, transcript, language, options.plainText?.paragraphBreaks, options.plainText?.whitespace)

	logger.end()
	logger.logDuration(`Total alignment time`, startTimestamp, chalk.magentaBright)

	return {
		timeline: segmentTimeline,
		wordTimeline: mappedTimeline,

		transcript,
		language,

		inputRawAudio,
		isolatedRawAudio,
		backgroundRawAudio,
	}
}

export async function alignSegments(sourceRawAudio: RawAudio, segmentTimeline: Timeline, alignmentOptions: AlignmentOptions) {
	const timeline: Timeline = []

	for (const segmentEntry of segmentTimeline) {
		const segmentText = segmentEntry.text

		const segmentStartTime = segmentEntry.startTime
		const segmentEndTime = segmentEntry.endTime

		const segmentStartSampleIndex = Math.floor(segmentStartTime * sourceRawAudio.sampleRate)
		const segmentEndSampleIndex = Math.floor(segmentEndTime * sourceRawAudio.sampleRate)

		const segmentAudioSamples = sourceRawAudio.audioChannels[0].slice(segmentStartSampleIndex, segmentEndSampleIndex)
		const segmentRawAudio: RawAudio = {
			audioChannels: [segmentAudioSamples],
			sampleRate: sourceRawAudio.sampleRate
		}

		const { wordTimeline: mappedTimeline } = await align(segmentRawAudio, segmentText, alignmentOptions)

		const segmentTimelineWithOffset = addTimeOffsetToTimeline(mappedTimeline, segmentStartTime)

		timeline.push(...segmentTimelineWithOffset)
	}

	return timeline
}

export interface AlignmentResult {
	timeline: Timeline
	wordTimeline: Timeline

	transcript: string
	language: string

	inputRawAudio: RawAudio
	isolatedRawAudio?: RawAudio
	backgroundRawAudio?: RawAudio
}

export type AlignmentEngine = 'dtw' | 'dtw-ra' | 'whisper'
export type PhoneAlignmentMethod = 'interpolation' | 'dtw'

export interface AlignmentOptions {
	engine?: AlignmentEngine

	language?: string

	isolate?: boolean

	crop?: boolean

	customLexiconPaths?: string[]

	languageDetection?: API.TextLanguageDetectionOptions

	vad?: API.VADOptions

	plainText?: API.PlainTextOptions

	subtitles?: SubtitlesConfig

	dtw?: {
		granularity?: DtwGranularity | DtwGranularity[]
		windowDuration?: number | number[]
		phoneAlignmentMethod?: PhoneAlignmentMethod
	}

	recognition?: API.RecognitionOptions

	separation?: API.SourceSeparationOptions

	whisper?: WhisperOptions
}

export const defaultAlignmentOptions: AlignmentOptions = {
	engine: 'dtw',

	language: undefined,

	isolate: false,

	crop: true,

	customLexiconPaths: undefined,

	languageDetection: {
	},

	plainText: {
		paragraphBreaks: 'double',
		whitespace: 'collapse'
	},

	subtitles: defaultSubtitlesBaseConfig,

	dtw: {
		granularity: 'auto',
		windowDuration: undefined,
		phoneAlignmentMethod: 'dtw'
	},

	recognition: {
		whisper: {
			temperature: 0.15,
			topCandidateCount: 5,
			punctuationThreshold: 0.2,
			maxTokensPerPart: 200,
			autoPromptParts: false,
			suppressRepetition: true,
		}
	},

	vad: {
		engine: 'adaptive-gate'
	},

	separation: {
	},

	whisper: {
	}
}

export const alignmentEngines: API.EngineMetadata[] = [
	{
		id: 'dtw',
		name: 'Dynamic Time Warping',
		description: 'Makes use of a synthesized reference to find the best mapping between the spoken audio and its transcript.',
		type: 'local'
	},
	{
		id: 'dtw-ra',
		name: 'Dynamic Time Warping with Recognition Assist',
		description: 'Makes use of both a synthesized reference and a synthsized recognized transcript to find the best mapping between the spoken audio and its transcript.',
		type: 'local'
	},
	{
		id: 'whisper',
		name: 'OpenAI Whisper',
		description: 'Extracts timestamps from the internal state of the Whisper recognition model (note: currently limited to a maximum audio duration of 30 seconds).',
		type: 'local'
	}
]
