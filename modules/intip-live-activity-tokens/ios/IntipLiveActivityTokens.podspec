Pod::Spec.new do |s|
  s.name           = 'IntipLiveActivityTokens'
  s.version        = '1.0.0'
  s.summary        = 'Reports ActivityKit update push tokens of every timetable Live Activity'
  s.description    = 'Reports ActivityKit update push tokens of every timetable Live Activity, including push-to-start ones'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = "**/*.{h,m,swift}"
end
